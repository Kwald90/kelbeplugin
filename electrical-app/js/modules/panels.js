// Panel schedules (S26): the panel directory as a spreadsheet in the company's own template
// (TG Electric's sheet: DESCRIPTION | CCT. NO | AMP || AMP | CCT. NO | DESCRIPTION, tandems split
// A/B, multi-pole breakers merged, CCT. NO cells coloured by leg), edited cell by cell, printed in
// the same layout and exported to .xlsx for Excel / Google Sheets. Phases follow the bus, with live
// phase balance and load against the main and a service/feeder summary for the company's code book
// (CEC by default). The layout model lives in lib/panel-sheet.js; the .xlsx writer in lib/xlsx.js.
import * as E from '../lib/nec.js';
import * as S from '../lib/cec/systems.js';
import * as CEC from '../lib/cec/index.js';
import * as PT from '../lib/panel-templates.js';
import * as PC from '../lib/panel-catalog.js';
import * as PS from '../lib/panel-sheet.js';
import { halfOf, isQuadInner, occupancy, spanTo, slotCount, SLOT_COUNTS } from '../lib/panel-sheet.js';
import { readXlsx, dataUrlBytes, xlsxFileName, XLSX_MIME } from '../lib/xlsx.js';
import { rankByUse, noteUse } from '../lib/usage-rank.js';
import { jobFocus } from '../lib/job-focus.js';
import { partNumber, breakerFamilyFor } from '../lib/breaker-partnumbers.js';
import { BRAND } from '../brand.js';
import { panelUrl, qrSvgNode } from '../lib/qr.js';

// The occupancy helpers moved to lib/panel-sheet.js; re-exported so existing imports keep working.
export { halfOf, isQuadInner, occupancy, slotCount } from '../lib/panel-sheet.js';

const BREAKERS = CEC.STANDARD_RATINGS.filter((a) => a <= 400);

// Fill-as-you-go wiring status. Empty = not tracked; the rest run start → finish.
export const PANEL_STATUSES = [
  { key: 'planned', label: 'Planned' },
  { key: 'rough-in', label: 'Rough-in' },
  { key: 'connected', label: 'Connected' },
  { key: 'tested', label: 'Tested' },
  { key: 'done', label: 'Done' },
];
export const PANEL_STATUS_LABEL = (k) => (PANEL_STATUSES.find((s) => s.key === k) || {}).label || '';

// Print options stored per company in settings.panelPrint. Band colours are photocopy-safe
// (a faint grey band alternating with white), amps shown, status hidden, smoke red.
// phaseBands: the CCT. NO leg fill on the sheet, screen, print and .xlsx — the template's red/grey
// (A red: circuits 1/2, B grey: 3/4, alternating) plus blue for C on 3φ. Independent of the
// wire-colour legend and overridable per company.
export const PANEL_PRINT_DEFAULTS = { bandColors: ['#eef2f7', '#ffffff'], showAmps: true, showStatus: false, phaseBandsOn: true, showLegend: true, showQr: true, smokeColor: '#e2231a', phaseBands: { ...PS.SHEET_LEG_DEFAULTS } };

/** Merge a company's settings.panelPrint onto the defaults, validating each field. Pure. */
export function panelPrintSettings(settings) {
  const pp = (settings && settings.panelPrint) || {};
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : d);
  const bc = Array.isArray(pp.bandColors) && pp.bandColors.length >= 2
    ? [hex(pp.bandColors[0], PANEL_PRINT_DEFAULTS.bandColors[0]), hex(pp.bandColors[1], PANEL_PRINT_DEFAULTS.bandColors[1])]
    : PANEL_PRINT_DEFAULTS.bandColors.slice();
  const dpb = PANEL_PRINT_DEFAULTS.phaseBands;
  const ipb = (pp.phaseBands && typeof pp.phaseBands === 'object') ? pp.phaseBands : {};
  const phaseBands = { A: hex(ipb.A, dpb.A), B: hex(ipb.B, dpb.B), C: hex(ipb.C, dpb.C) };
  return {
    bandColors: bc,
    showAmps: pp.showAmps !== false,
    showStatus: pp.showStatus === true,
    phaseBandsOn: pp.phaseBandsOn !== false,
    showLegend: pp.showLegend !== false,
    showQr: pp.showQr !== false,
    smokeColor: hex(pp.smokeColor, PANEL_PRINT_DEFAULTS.smokeColor),
    phaseBands,
  };
}

// Terse type tags for the print AMP column — the engineered sheet's compact style ("15", "15 AFI",
// "30A 2P"), not the verbose construction labels. A tandem's half-space is already shown by the A/B
// in the CCT.NO cell and a quad by the 2P + grouping, so neither adds a tag here. Pure.
export const PRINT_AMP_TYPE_TAGS = PS.AMP_TAGS;
export const printAmpTag = (c) => (c && PRINT_AMP_TYPE_TAGS[c.breakerType] ? ' ' + PRINT_AMP_TYPE_TAGS[c.breakerType] : '');
/**
 * The AMP cell text for the printed schedule: a single-pole shows just the amps plus a type tag when
 * not standard ("15", "15 AFI"); a multi-pole keeps its pole count ("30A 2P", "40A 2P"). Compact and
 * single-line. `poles` overrides the circuit's own count (a quad inner crosses 2). Pure.
 */
export function printAmpText(c, poles) {
  if (!c || c.amps == null || c.amps === '') return '';
  const p = Number(poles) || Number(c.poles) || 1;
  const tag = printAmpTag(c);
  return p > 1 ? `${c.amps}A ${p}P${tag}` : `${c.amps}${tag}`;
}

/** The print table's classes: a dense, engineered-schedule directory (vs. the airy web look). */
export const PANEL_PRINT_TABLE_CLASS = 'panel-print-table pp-dense';

/**
 * The CSS class that puts a CCT cell onto its phase band. The band colour itself is a CSS variable
 * (--pp-ph-A/B/C) set on the print table from the company's phase palette, so each cell carries only
 * a class — no per-cell inline colour. Pure.
 */
export const phaseBandClass = (phase) => 'pp-ph-' + phase;

/**
 * Legible text colour (#ffffff or a near-black) for text sitting on a phase band of the given hex,
 * by perceived luminance — so a black or red band reads white and a light band reads dark. Pure.
 */
export function bandTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#111111';
  const n = parseInt(m[1], 16);
  const L = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return L < 0.45 ? '#ffffff' : '#111111';
}

/**
 * The boxed titleblock rows for the printed schedule — PANEL NAME / PANEL LOCATION in bordered
 * label+value cells, then the service line — like an engineered drawing's titleblock. A missing
 * name or location falls back to a dash so a cell is never blank. Pure.
 */
export function panelTitleblock(panel, service) {
  return [
    { label: 'PANEL NAME', value: (panel && panel.name) || '—' },
    { label: 'PANEL LOCATION', value: (panel && panel.location) || '—' },
    { service: service || '' },
  ];
}

/**
 * Alternating band index (0 or 1) for every space, so each breaker's spaces read as one band and
 * the next breaker alternates. Computed down each column (odd slots, then even), so a multi-pole
 * breaker — whose spaces stack in one column — is a single band, and two tandems that share a
 * space share its band. Pure. Returns a Map slot -> 0|1.
 */
export function bandIndexBySlot(circuits, total) {
  const occ = occupancy(circuits || []);
  const map = new Map();
  for (const start of [1, 2]) {
    let parity = 0, prevKey = null, first = true;
    for (let slot = start; slot <= total; slot += 2) {
      const o = occ.get(slot);
      let key;
      if (o && o.full) key = 'f:' + o.full.slot;          // a full breaker: keyed by its first space
      else if (o && (o.A || o.B)) key = 't:' + slot;       // a tandem space: both halves one band
      else key = 'e:' + slot;                              // empty space: its own band
      if (first) first = false; else if (key !== prevKey) parity ^= 1;
      map.set(slot, parity);
      prevKey = key;
    }
  }
  return map;
}

/**
 * Fill-as-you-go completion: of the circuits that have a description (the ones actually planned),
 * how many are marked 'done'. Pure. Returns { total, described, done, tracked, pct }.
 */
export function completion(panel) {
  const circuits = (panel && panel.circuits) || [];
  const described = circuits.filter((c) => (c.description || '').trim());
  const done = described.filter((c) => c.status === 'done');
  const tracked = circuits.filter((c) => c.status && c.status !== '');
  return {
    total: circuits.length,
    described: described.length,
    done: done.length,
    tracked: tracked.length,
    pct: described.length ? Math.round((done.length / described.length) * 100) : 0,
  };
}

/**
 * The highlight colour for a circuit, or null for none. A #rrggbb colorOverride is an explicit
 * highlight; 'none' suppresses it; otherwise a 'smoke'/'alarm' purpose highlights red (the
 * company's smokeColor). A phase-key colorOverride (A/B/C) is not a highlight. Pure.
 */
export function highlightFor(circuit, pp = PANEL_PRINT_DEFAULTS) {
  const ov = circuit && circuit.colorOverride;
  if (ov === 'none') return null;
  if (ov && /^#[0-9a-f]{6}$/i.test(ov)) return ov;
  const purpose = String((circuit && circuit.purpose) || '').toLowerCase();
  if (purpose === 'smoke' || purpose === 'alarm' || purpose.includes('smoke')) return pp.smokeColor || PANEL_PRINT_DEFAULTS.smokeColor;
  return null;
}

/**
 * Convert a tandem half back to a full-size breaker, in place, when its sibling half is empty
 * (clears `half`, and a 'tandem' type falls back to 'standard'). Pure on the passed array; returns
 * true on success, false if it isn't a half or the sibling space is occupied.
 */
export function makeFullSpace(circuits, c) {
  const half = halfOf(c);
  if (!half) return false;
  const slot = Number(c.slot);
  if (isQuadInner(c)) {
    // A quad inner 2-pole becomes a full-space 2-pole at the same slot, but only if the two outer
    // halves it was sharing with (this space's 'A', the next space's 'B') are empty.
    const next = slot + 2;
    const blocked = (circuits || []).some((x) => x !== c
      && ((Number(x.slot) === slot && halfOf(x) === 'A') || (Number(x.slot) === next && halfOf(x) === 'B')));
    if (blocked) return false;
    delete c.half; // poles stays 2: now a full-space 2-pole spanning its two spaces
    return true;
  }
  const sibling = half === 'A' ? 'B' : 'A';
  if ((circuits || []).some((x) => x !== c && Number(x.slot) === slot && halfOf(x) === sibling)) return false;
  delete c.half;
  if (c.breakerType === 'tandem') c.breakerType = 'standard';
  return true;
}

// ---------------------------------------------------------------------------
// Panel catalogue: manufacturer → line → size, the line's tandem/quad rules, and the per-slot
// breaker part number. Pure helpers (no DOM) so the picker, the affordance gating and the slot-fill
// SKU are all testable; the editor wires them to the UI. See js/lib/panel-catalog.js and
// js/lib/breaker-partnumbers.js for the data and the SKU generator.
// ---------------------------------------------------------------------------

/** The tandem mode a panel's breaker line allows: 'none'/'marked' when the catalogue set one, else
 *  'all' (the default for a blank/legacy panel — unchanged behaviour). Pure. */
export function tandemsModeOf(panel) {
  const m = panel && panel.tandemsMode;
  return m === 'none' || m === 'marked' ? m : 'all';
}

/** Whether a panel offers tandem (half-space) affordances: the system must allow 1-pole breakers
 *  (has a neutral) AND the line must take tandems. `systemHasNeutral` is S.minPoles(voltage) === 1. Pure. */
export function panelOffersTandems(panel, systemHasNeutral) {
  return !!systemHasNeutral && tandemsModeOf(panel) !== 'none';
}

/** Whether a panel offers the quad (space-saver) affordance: tandems offered and the line's quad
 *  flag is not explicitly false (a blank/legacy panel, flag undefined, still offers it). Pure. */
export function panelOffersQuad(panel, systemHasNeutral) {
  return panelOffersTandems(panel, systemHasNeutral) && (panel ? panel.quad !== false : true);
}

/** The panel fields implied by picking a catalogue entry + one of its sizes in the New-panel flow.
 *  A size implies spaces + main amps + bus + main type; the line implies the breaker family (the
 *  generator key that drives slot-fill SKUs — null for proprietary lines), width, tandem mode and
 *  quad flag. Voltage defaults to residential single-phase; the editor keeps the full system list. Pure. */
export function panelFromCatalog(entry, size, jobId = null) {
  const family = breakerFamilyFor(entry);
  return {
    jobId: jobId || null,
    name: `${entry.manufacturer} ${entry.line}`,
    voltage: '120/240 1ph',
    mainType: size.mainType === 'MLO' ? 'MLO' : 'MB',
    mainAmps: Number(size.amps) || 0,
    busAmps: Number(size.busAmps) || 0,
    slots: Number(size.spaces) || 40,
    feedThrough: false,
    templateId: null,
    manufacturer: entry.manufacturer,
    line: entry.line,
    breakerFamily: family,
    breakerWidth: entry.breakerWidth,
    tandemsMode: entry.tandems,
    quad: !!entry.quad,
    circuits: [],
  };
}

/** The breaker-part spec for a circuit, or null when the panel has no breaker family or the circuit
 *  is a quad's outer single (part of the one quad device, with no SKU of its own). A tandem passes
 *  both halves' amps (one physical body); a quad inner passes the inner amp plus the two outer amps. Pure. */
export function partSpecFor(panel, c, circuits) {
  const family = panel && panel.breakerFamily;
  if (!family || !c) return null;
  const list = circuits || (panel && panel.circuits) || [];
  const amps = Number(c.amps) || 0;
  // A sheet row typed with a description but no size yet has no part number until the amps are in.
  if (!amps && !halfOf(c)) return null;
  if (isQuadInner(c)) {
    const occ = occupancy(list);
    const o = occ.get(Number(c.slot)) || {};
    const o2 = occ.get(Number(c.slot) + 2) || {};
    const outerA = o.A && !isQuadInner(o.A) ? (Number(o.A.amps) || amps) : amps;
    const outerB = o2.B && !isQuadInner(o2.B) ? (Number(o2.B.amps) || amps) : amps;
    return { family, breakerType: 'quad', amps, tandemAmps: [outerA, outerB] };
  }
  if (halfOf(c)) {
    const occ = occupancy(list);
    const o = occ.get(Number(c.slot)) || {};
    if (isQuadInner(o.A) || isQuadInner(o.B)) return null; // a quad's outer single: no own SKU
    const bt = c.breakerType || 'tandem';
    if (bt === 'tandem') {
      const a = o.A ? Number(o.A.amps) || 0 : 0;
      const b = o.B ? Number(o.B.amps) || 0 : 0;
      return { family, breakerType: 'tandem', tandemAmps: [a || amps, b || a || amps] };
    }
    return { family, breakerType: bt, poles: 1, amps };
  }
  return { family, breakerType: c.breakerType || 'standard', poles: Number(c.poles) || 1, amps };
}

/** The resolved part number for a circuit ({ number, confident, note }), or null when the panel
 *  has no family or the circuit carries no SKU of its own. Pure. */
export function circuitPartNumber(panel, c, circuits) {
  const spec = partSpecFor(panel, c, circuits);
  return spec ? partNumber(spec) : null;
}

/** Return the circuits with auto part numbers stamped on `partNo`, leaving a manual override
 *  (`partNoManual`) untouched — a manual value always wins. Clears `partNo` when the panel has no
 *  family or the circuit resolves to none. Pure (returns fresh objects for the ones it changes). */
export function applyPartNumbers(panel, circuits) {
  const family = panel && panel.breakerFamily;
  return (circuits || []).map((c) => {
    if (c.partNoManual) return c; // a manual value wins and is never overwritten
    const out = { ...c };
    if (family) {
      const r = circuitPartNumber(panel, out, circuits);
      if (r && r.number) out.partNo = r.number; else delete out.partNo;
    } else if ('partNo' in out) {
      delete out.partNo;
    }
    return out;
  });
}

/**
 * Panel record fields from an imported sheet (PS.panelFromSheet output): the sheet's name, location,
 * service and circuits, with phases stamped and anything the sheet doesn't say defaulted the way a
 * blank panel is. Pure.
 */
export function panelFromImport(parsed, { jobId = null, fileName = '' } = {}) {
  const voltage = parsed.voltage || '120/240 1ph';
  const minP = S.minPoles(voltage);
  const circuits = (parsed.circuits || [])
    .filter((c) => halfOf(c) ? minP === 1 : (Number(c.poles) || 1) >= minP)
    .map((c) => ({ ...c, phase: S.circuitPhases(c.slot, halfOf(c) ? (isQuadInner(c) ? 2 : 1) : (Number(c.poles) || 1), voltage) }));
  const main = Number(parsed.mainAmps) || 0;
  return {
    jobId: jobId || null,
    name: String(parsed.name || '').trim() || String(fileName || '').replace(/\.xlsx$/i, '').trim() || 'Imported panel',
    location: String(parsed.location || '').trim() || null,
    voltage,
    mainType: parsed.mainType === 'MLO' ? 'MLO' : 'MB',
    mainAmps: main || 200,
    busAmps: main || 200,
    slots: Number(parsed.slots) || 40,
    feedThrough: false,
    templateId: null,
    circuits,
  };
}

let ui, h, store;
const bookOf = () => (store.settings().codeBook === 'NEC-2023' ? 'NEC-2023' : 'CEC-2024');

/**
 * The three circuits of a space-saver quad placed at `slot`, in top-to-bottom order: an outer
 * single (this space's upper half 'A'), the inner handle-tied 2-pole (this space's lower half 'B',
 * reaching the next space's upper half 'A'), and an outer single (the next space's lower half 'B').
 * The inner is a real 2-pole typed 'quad' — never a tandem. Pure; the editor stamps phases on save.
 */
export function quadCircuits(slot) {
  slot = Number(slot);
  const next = slot + 2;
  return [
    { slot, half: 'A', poles: 1, description: '', amps: 20, loadVA: 0, breakerType: 'tandem', phase: '' },
    { slot, half: 'B', poles: 2, description: '', amps: 20, loadVA: 0, breakerType: 'quad', phase: '' },
    { slot: next, half: 'B', poles: 1, description: '', amps: 20, loadVA: 0, breakerType: 'tandem', phase: '' },
  ];
}

/** Poles used for phase assignment: a normal tandem is 1 pole; a quad inner crosses 2; a full breaker uses its own count. */
const phasePolesOf = (c) => (halfOf(c) ? (isQuadInner(c) ? 2 : 1) : (Number(c.poles) || 1));

/** Identity of a circuit within a panel: same space and same half (full breakers share the null half). */
const sameCircuit = (a, b) => Number(a.slot) === Number(b.slot) && (halfOf(a) || '') === (halfOf(b) || '');

const circuitAmps = S.circuitAmps;
const sysLabel = (key) => S.PANEL_SYSTEMS[key]?.label || key;

/** True if a space holds any breaker (a full one or either half). */
const spaceTaken = (o) => !!(o && (o.full || o.A || o.B));

/**
 * Pure placement check: can a breaker go at `slot` in `circuits` on a panel of
 * `total` spaces? `half` 'A'/'B' means a tandem (half space); otherwise a full
 * breaker of `poles` poles. Returns { ok } or { ok:false, reason } with a
 * ready-to-toast message. Pole/system rules (neutral, three-phase) are checked
 * by the caller; this only enforces physical collisions.
 */
export function placement(circuits, { slot, poles = 1, half = null }, total) {
  slot = Number(slot);
  const occ = occupancy(circuits);
  if (half === 'A' || half === 'B') {
    if ((Number(poles) || 1) >= 2) {
      // Quad (space-saver) inner 2-pole: it takes this space's lower half and the next space's upper half.
      if (half !== 'B') return { ok: false, reason: `A quad's inner 2-pole sits in the lower half of a space; pick that space.` };
      const next = slot + 2;
      if (next > total) return { ok: false, reason: `A quad at space ${slot} needs space ${next}, past the end of the panel.` };
      const o = occ.get(slot), o2 = occ.get(next);
      // A quad is one device laid out as three breakers filling ALL FOUR half-positions across the
      // two spaces: an outer single in this space's 'A', the inner 2-pole in this space's 'B' + the
      // next space's 'A', and an outer single in the next space's 'B'. Every one of those must be
      // free, or placing the quad would overwrite an existing breaker and silently lose it.
      if (o && o.full) return { ok: false, reason: `Space ${slot} has a full-size breaker, so a quad can't share it.` };
      if (o && o.A) return { ok: false, reason: `Space ${slot}A is taken, so a quad's top breaker can't go there.` };
      if (o && o.B) return { ok: false, reason: `Space ${slot}B is taken, so a quad's inner breaker can't go there.` };
      if (o2 && o2.full) return { ok: false, reason: `Space ${next} has a full-size breaker, so a quad can't share it.` };
      if (o2 && o2.A) return { ok: false, reason: `Space ${next}A is taken, so a quad's inner breaker can't go there.` };
      if (o2 && o2.B) return { ok: false, reason: `Space ${next}B is taken, so a quad's bottom breaker can't go there.` };
      return { ok: true };
    }
    const o = occ.get(slot);
    if (o && o.full) return { ok: false, reason: `Space ${slot} has a full-size breaker, so a tandem can't share it.` };
    if (o && o[half]) return { ok: false, reason: `Space ${slot}${half} already has a tandem.` };
    return { ok: true };
  }
  for (let k = 0; k < (Number(poles) || 1); k++) {
    const s = slot + 2 * k;
    if (s > total) return { ok: false, reason: `A ${poles}-pole breaker at space ${slot} needs space ${s}, past the end of the panel.` };
    const o = occ.get(s);
    if (spaceTaken(o)) return { ok: false, reason: `A ${poles}-pole breaker at space ${slot} needs space ${s}, which is taken.` };
  }
  return { ok: true };
}

function withPhases(circuits, system) {
  return circuits.map((c) => ({ ...c, phase: S.circuitPhases(c.slot, phasePolesOf(c), system) }));
}

function summary(panel) {
  const sys = S.systemOf(panel.voltage);
  const b = S.phaseBalance(panel.circuits || [], panel.voltage);
  const main = Number(panel.mainAmps) || 0;
  const loadPct = main ? (b.maxAmps / main) * 100 : 0;
  return { sys, b, main, loadPct };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function listView(root, ctx) {
  // A ?jobId= link wins; otherwise the person's "Working on" job (lib/job-focus) filters the list,
  // and ?all=1 (the "All panels" button) shows every panel.
  const jobId = ctx.query.jobId || (ctx.query.all ? '' : jobFocus(store, ctx.auth));
  const jobs = store.list('jobs');
  const jobName = (id) => { const j = jobs.find((x) => x.id === id); return j ? `${j.number} · ${j.title}` : '—'; };
  const panels = store.list('panels', (p) => !jobId || p.jobId === jobId);

  const createFrom = (tpl) => {
    const fields = tpl
      ? { jobId: jobId || null, name: tpl.label.split(' · ')[0] || 'New panel', voltage: tpl.voltage, mainType: tpl.mainType || 'MB', mainAmps: tpl.mainAmps ?? 0, busAmps: tpl.busAmps ?? 0, slots: tpl.slots ?? 40, feedThrough: !!tpl.feedThrough, templateId: tpl.id, circuits: [] }
      : { jobId: jobId || null, name: 'New panel', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 40, feedThrough: false, templateId: null, circuits: [] };
    const p = store.add('panels', fields);
    ctx.nav('#/panels/' + p.id);
  };

  const createFromCatalog = (entry, size) => {
    const p = store.add('panels', panelFromCatalog(entry, size, jobId));
    ctx.nav('#/panels/' + p.id);
  };

  // A filled panel schedule (.xlsx, in the template) back into a new panel.
  const importXlsx = async () => {
    const file = await ui.pickFile('.xlsx,' + XLSX_MIME);
    if (!file) return;
    let parsed;
    try {
      parsed = PS.panelFromSheet(await readXlsx(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      ui.toast(`Couldn't read ${file.name}: ${e.message}`, 'error', 5000);
      return;
    }
    const p = store.add('panels', panelFromImport(parsed, { jobId, fileName: file.name }));
    const n = p.circuits.length;
    ui.toast(`Imported ${n} circuit${n === 1 ? '' : 's'}${parsed.skipped ? `; ${parsed.skipped} merged cell${parsed.skipped === 1 ? '' : 's'} couldn't be read as one breaker` : ''}`, parsed.skipped ? 'info' : 'success', 4200);
    ctx.nav('#/panels/' + p.id);
  };

  // Manufacturer → line → size picker. Three selects sourced from the catalogue, defaulting to the
  // catalogue DEFAULT (Square D Homeline 200 A / 40 MB). Choosing sets the panel's spaces, main amps,
  // bus, main type, and the breaker family / tandem mode / quad flag that drive slot-fill part numbers.
  const catalogPicker = () => {
    let mfr = PC.DEFAULT.manufacturer;
    let line = PC.DEFAULT.line;
    const mfrSel = h('select', { class: 'input', name: 'mfr', 'aria-label': 'Manufacturer' },
      PC.manufacturers().map((m) => h('option', { value: m, selected: m === mfr }, m)));
    const lineSel = h('select', { class: 'input', name: 'line', 'aria-label': 'Line' });
    const sizeSel = h('select', { class: 'input', name: 'size', 'aria-label': 'Size' });
    const noteEl = h('div', { class: 'catalog-note muted small' });
    const curEntry = () => PC.catalogEntry(mfr, line);
    const curSize = () => PC.sizesFor(mfr, line)[Number(sizeSel.value) || 0] || null;
    const fillLines = () => {
      const lines = PC.linesFor(mfr);
      if (!lines.includes(line)) line = lines[0];
      ui.clear(lineSel).append(...lines.map((l) => h('option', { value: l, selected: l === line }, l)));
    };
    const fillSizes = () => {
      const sizes = PC.sizesFor(mfr, line);
      const def = (mfr === PC.DEFAULT.manufacturer && line === PC.DEFAULT.line)
        ? sizes.findIndex((s) => s.amps === PC.DEFAULT.amps && s.spaces === PC.DEFAULT.spaces && s.mainType === PC.DEFAULT.mainType) : 0;
      ui.clear(sizeSel).append(...sizes.map((s, i) => h('option', { value: i, selected: i === Math.max(0, def) },
        `${s.amps} A · ${s.spaces} spaces · ${s.mainType}`)));
    };
    const refreshNote = () => {
      const e = curEntry();
      ui.clear(noteEl);
      if (!e) return;
      const fam = breakerFamilyFor(e);
      const tmode = e.tandems === 'none' ? 'no tandems' : e.tandems === 'marked' ? 'tandems in marked slots only' : 'tandems allowed';
      noteEl.append(h('div', null, `${e.breakerFamily} · ${e.breakerWidth} · ${tmode}${e.quad ? ' · quads' : ''}`));
      if (!fam) noteEl.append(h('div', { class: 'muted' }, 'Proprietary line: no automatic part numbers.'));
      if (e.safetyFlag) noteEl.append(h('div', { class: 'catalog-flag' }, ui.icon('alert', 14), ' ', e.safetyFlag));
    };
    mfrSel.addEventListener('change', () => { mfr = mfrSel.value; fillLines(); fillSizes(); refreshNote(); });
    lineSel.addEventListener('change', () => { line = lineSel.value; fillSizes(); refreshNote(); });
    fillLines(); fillSizes(); refreshNote();
    return { mfrSel, lineSel, sizeSel, noteEl, curEntry, curSize };
  };

  const create = () => {
    const book = store.settings().codeBook === 'NEC-2023' ? 'NEC-2023' : 'CEC-2024';
    const region = book === 'NEC-2023' ? 'US' : 'CA';
    const templates = PT.listPanelTemplates(store.settings()).filter((t) => !t.region || t.region.includes(region) || t.custom);
    const pick = catalogPicker();
    const sheet = ui.openSheet({
      title: 'New panel',
      body: h('div', { class: 'stack' },
        h('div', { class: 'card panel-picker' },
          h('div', { class: 'calc-label' }, 'Pick the panel'),
          h('div', { class: 'form-grid' },
            h('label', { class: 'field' }, h('span', null, 'Manufacturer'), pick.mfrSel),
            h('label', { class: 'field' }, h('span', null, 'Line'), pick.lineSel),
            h('label', { class: 'field span-2' }, h('span', null, 'Size'), pick.sizeSel)),
          pick.noteEl,
          h('div', { class: 'row' }, h('span', { class: 'grow' }),
            ui.button('Create panel', { variant: 'primary', icon: 'plus', onClick: () => {
              const e = pick.curEntry(); const s = pick.curSize();
              if (!e || !s) { ui.toast('Pick a manufacturer, line and size', 'error'); return; }
              sheet.close(); createFromCatalog(e, s);
            } })),
          h('p', { class: 'calc-note muted' }, 'The size sets spaces, main amps, bus and main type; the line sets which breakers fit and the part numbers.')),
        h('div', { class: 'tpl-list' },
          h('div', { class: 'calc-label' }, 'Or start from a preset'),
          h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); createFrom(null); } },
            h('strong', null, 'Blank / generic panel'), h('span', { class: 'muted' }, '120/240 V · 200 A · 40 spaces · no breaker family')),
          templates.map((t) => h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); createFrom(t); } },
            h('strong', null, t.label), h('span', { class: 'muted' }, `${t.mainType}${t.feedThrough ? ' · feed-through' : ''}${t.custom ? ' · company' : ''}`))))),
    });
  };

  root.append(ui.page(
    {
      title: 'Panel schedules',
      subtitle: jobId ? `For ${jobName(jobId)}` : 'Directories, phase balance and load per panel',
      actions: [
        jobId ? ui.button('All panels', { variant: 'ghost', href: '#/panels?all=1' }) : null,
        ui.button('Import .xlsx', { variant: 'ghost', icon: 'upload', title: 'Import a filled panel schedule spreadsheet', onClick: importXlsx }),
        ui.button('New panel', { variant: 'primary', icon: 'plus', onClick: create }),
      ].filter(Boolean),
    },
    ui.table({
      columns: [
        { key: 'name', label: 'Panel', sort: (p) => p.name, render: (p) => h('strong', null, p.name) },
        { key: 'job', label: 'Job', sort: (p) => jobName(p.jobId), render: (p) => jobName(p.jobId) },
        { key: 'voltage', label: 'System', render: (p) => sysLabel(p.voltage) },
        { key: 'main', label: 'Main', align: 'right', sort: (p) => Number(p.mainAmps) || 0, render: (p) => `${p.mainAmps || '—'} A` },
        { key: 'circuits', label: 'Circuits', align: 'right', render: (p) => String((p.circuits || []).length) },
        { key: 'va', label: 'Load', align: 'right', sort: (p) => summary(p).b.totalVA, render: (p) => `${ui.fmtNum(summary(p).b.totalVA)} VA` },
        {
          key: 'bal', label: 'Imbalance', align: 'right', sort: (p) => summary(p).b.imbalancePct,
          render: (p) => { const s = summary(p); return ui.badge(`${ui.fmtNum(s.b.imbalancePct, 1)}%`, s.b.imbalancePct > 10 ? 'warning' : 'success'); },
        },
      ],
      rows: panels,
      onRowClick: (p) => ctx.nav('#/panels/' + p.id),
      empty: ui.empty({ icon: 'panel', title: 'No panel schedules yet', text: 'Lay out breakers slot by slot and watch the phase balance as you go.', action: ui.button('New panel', { variant: 'primary', icon: 'plus', onClick: create }) }),
    }),
  ));
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function editorView(root, ctx, id) {
  let panel = store.get('panels', id);
  if (!panel) {
    root.append(ui.page({ title: 'Panel not found' }, ui.empty({ icon: 'panel', title: 'This panel was deleted', action: ui.button('All panels', { href: '#/panels' }) })));
    return;
  }
  const jobs = store.list('jobs');

  // Every change saves and redraws at once; the sheet then puts focus back where it belongs
  // (see focusCell / afterCommit below).
  const save = (patch, opts) => {
    panel = store.update('panels', panel.id, patch, opts);
    redraw();
  };
  const setCircuits = (circuits) => save({ circuits: applyPartNumbers(panel, withPhases(circuits, panel.voltage)) });
  /** The resolved part number ({ number, confident, note }) for a circuit in this panel, or null. */
  const partOf = (c) => (panel.breakerFamily ? circuitPartNumber(panel, c, panel.circuits || []) : null);

  // Every slot a circuit sits in, so the residential fill lands only in the empty spaces.
  const occupiedSlots = () => {
    const taken = new Set();
    for (const c of panel.circuits || []) {
      if (halfOf(c)) { taken.add(Number(c.slot)); if (isQuadInner(c)) taken.add(Number(c.slot) + 2); }
      else { const p = Number(c.poles) || 1; for (let k = 0; k < p; k++) taken.add(Number(c.slot) + 2 * k); }
    }
    return [...taken];
  };

  // Drop the common house circuits into the empty spaces, placed for balanced load (lib/panel-templates).
  const fillResidential = () => {
    if (S.systemOf(panel.voltage).three) { ui.toast('Residential essentials are for a single-phase panel.', 'info'); return; }
    const rows = PT.residentialEssentials();
    const boxes = {};
    const spec = (r) => `${r.amps} A${r.poles >= 2 ? ' 2-pole' : ''}${r.breakerType !== 'standard' ? ' ' + r.breakerType.toUpperCase() : ''}`;
    const tierLabel = { required: 'Code expects these on most dwellings', recommended: 'Standard good practice', optional: 'Add if the house has it' };
    const body = h('div', { class: 'stack resi-checklist' },
      h('p', { class: 'muted' }, 'Drops the common house circuits into the empty spaces, placed across the phases for balanced load. A reminder from the Canadian Electrical Code and common practice; verify against the code in force where you work.'),
      ...['required', 'recommended', 'optional'].map((t) => {
        const group = rows.filter((r) => r.tier === t);
        if (!group.length) return null;
        return h('div', { class: 'stack resi-tier' },
          h('div', { class: 'resi-tier-label muted' }, tierLabel[t]),
          ...group.map((r) => {
            const cb = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: r.defaultOn, 'aria-label': r.label });
            boxes[r.id] = cb;
            return h('label', { class: 'resi-row' },
              h('span', { class: 'grow' }, h('strong', null, r.label),
                h('span', { class: 'resi-spec muted' }, ` · ${spec(r)}${r.count > 1 ? ` × ${r.count}` : ''}`),
                r.note ? h('div', { class: 'resi-note muted' }, r.note) : null),
              cb);
          }));
      }).filter(Boolean));
    const sheet = ui.openSheet({
      title: 'Residential essentials', body,
      actions: [
        ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }),
        ui.button('Fill empty spaces', { variant: 'primary', icon: 'home', onClick: () => {
          const ids = rows.filter((r) => boxes[r.id] && boxes[r.id].checked).map((r) => r.id);
          const specs = PT.expandResidentialEssentials(ids);
          const placed = PT.layoutResidentialCircuits(specs, { system: panel.voltage, slots: slotCount(panel), occupied: occupiedSlots() });
          if (!placed.length) { ui.toast(specs.length ? 'No empty spaces to fill.' : 'Nothing ticked.', 'info'); sheet.close(); return; }
          setCircuits([...(panel.circuits || []), ...placed]);
          const missed = specs.length - placed.length;
          ui.toast(`Added ${placed.length} circuit${placed.length > 1 ? 's' : ''}${missed > 0 ? `; ${missed} didn’t fit the spaces left` : ''}`, missed > 0 ? 'info' : 'success');
          sheet.close();
        } }),
      ],
    });
  };

  // header form
  const head = h('form', { class: 'card panel-head no-print', onSubmit: (e) => e.preventDefault() }, ui.formGrid([
    { label: 'Panel name', name: 'name', value: panel.name, required: true },
    { label: 'Location', name: 'location', value: panel.location || '', placeholder: 'e.g. Mechanical room, east wall' },
    { label: 'Job', name: 'jobId', type: 'select', value: panel.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) },
    { label: 'System', name: 'voltage', type: 'select', value: panel.voltage, options: S.systemsFor(bookOf(), panel.voltage) },
    { label: 'Main type', name: 'mainType', type: 'select', value: panel.mainType || 'MB', options: [{ value: 'MB', label: 'Main breaker (MB)' }, { value: 'MLO', label: 'Main lug only (MLO)' }] },
    { label: (panel.mainType === 'MLO' ? 'Main OCPD (A)' : 'Main (A)'), name: 'mainAmps', type: 'number', value: panel.mainAmps, min: 0, step: 1, hint: panel.mainType === 'MLO' ? 'No main breaker; upstream feed rating' : null },
    { label: 'Bus (A)', name: 'busAmps', type: 'number', value: panel.busAmps, min: 0, step: 1 },
    { label: 'Spaces', name: 'slots', type: 'select', value: String(slotCount(panel)), options: SLOT_COUNTS.map(String) },
    { label: 'Feed-through lugs', name: 'feedThrough', type: 'checkbox', value: !!panel.feedThrough },
  ]));
  head.addEventListener('change', () => {
    const v = ui.readForm(head);
    const slots = Number(v.slots);
    const tooFar = (panel.circuits || []).some((c) => spanTo(c) > slots);
    if (tooFar) {
      ui.toast('Some breakers sit past that space count. Move them first.', 'error');
      head.querySelector('[name=slots]').value = String(slotCount(panel));
      return;
    }
    const single = (panel.circuits || []).filter((c) => (Number(c.poles) || 1) < S.minPoles(v.voltage));
    const threePole = (panel.circuits || []).filter((c) => Number(c.poles) === 3);
    if (single.length || (threePole.length && !S.systemOf(v.voltage).three)) {
      ui.toast(single.length
        ? `${S.systemOf(v.voltage).label} has no neutral, so 1-pole breakers can't be used. Change breaker${single.length > 1 ? 's' : ''} ${single.map((c) => c.slot).join(', ')} first.`
        : '3-pole breakers need a three-phase system. Change them first.', 'error', 4200);
      head.querySelector('[name=voltage]').value = panel.voltage;
      return;
    }
    panel = store.update('panels', panel.id, {
      name: v.name || 'Panel', location: v.location || null, jobId: v.jobId || null, voltage: v.voltage, mainType: v.mainType === 'MLO' ? 'MLO' : 'MB',
      mainAmps: v.mainAmps ?? 0, busAmps: v.busAmps ?? 0, slots, feedThrough: !!v.feedThrough,
      circuits: withPhases(panel.circuits || [], v.voltage),
    });
    redraw();
  });

  const summaryEl = h('div', { class: 'panel-summary' });
  const gridEl = h('div', { class: 'ps-grid no-print' });
  const printEl = h('div', { class: 'print-only panel-print' });
  const labelPrintEl = h('div', { class: 'panel-label-print' });

  const serviceText = () => {
    const mainTxt = panel.mainType === 'MLO' ? `MLO${panel.mainAmps ? ' · ' + panel.mainAmps + ' A feed' : ''}` : `${panel.mainAmps} A main`;
    return `${sysLabel(panel.voltage)} · ${mainTxt}`;
  };
  const appOrigin = () => BRAND.appOrigin || (typeof location !== 'undefined' ? location.origin : '');
  const thisPanelUrl = () => panelUrl(panel, appOrigin());

  /** Print only the panel label/sticker (not the directory): flip a class, print, then restore. */
  const printLabel = () => {
    const page = root.querySelector('.panel-page') || root.lastElementChild;
    if (!page) { window.print(); return; }
    page.classList.add('print-label-only');
    const cleanup = () => { page.classList.remove('print-label-only'); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };

  /** What shows on the printed schedule — toggles, company-wide, applied live. */
  const openPrintOptions = () => {
    const pp = panelPrintSettings(store.settings());
    return ui.formSheet({
      title: 'Print options',
      fields: [
        { label: 'Breaker size (amps)', name: 'showAmps', type: 'checkbox', value: pp.showAmps, hint: 'Print the sizes in the AMP columns' },
        { label: 'Leg colours (red / grey)', name: 'phaseBandsOn', type: 'checkbox', value: pp.phaseBandsOn, hint: 'Fill each CCT. NO cell by its leg, on screen, on paper and in Excel' },
        { label: 'Wiring status', name: 'showStatus', type: 'checkbox', value: pp.showStatus },
        { label: 'Colour legend & code note', name: 'showLegend', type: 'checkbox', value: pp.showLegend },
        { label: 'QR code', name: 'showQr', type: 'checkbox', value: pp.showQr },
        { label: 'Phone, website and email under the logo', name: 'contactLine', type: 'checkbox', value: PS.sheetSettings(store.settings()).contactLine, hint: 'From Settings → Company. Turn off when your logo already shows them' },
      ],
      submitLabel: 'Apply',
      onSubmit: (v) => {
        const cur = (store.settings().panelPrint && typeof store.settings().panelPrint === 'object') ? store.settings().panelPrint : {};
        const sheetCur = (store.settings().panelSheet && typeof store.settings().panelSheet === 'object') ? store.settings().panelSheet : {};
        store.saveSettings({
          panelPrint: { ...cur, showAmps: !!v.showAmps, phaseBandsOn: !!v.phaseBandsOn, showStatus: !!v.showStatus, showLegend: !!v.showLegend, showQr: !!v.showQr },
          panelSheet: { ...sheetCur, contactLine: !!v.contactLine },
        });
        redraw();
        ui.toast('Print options saved', 'success');
      },
    });
  };

  /** True if the current system allows tandems (single-pole half breakers need a neutral). */
  const tandemsAllowed = () => S.minPoles(panel.voltage) === 1;
  // The breaker LINE drives which affordances are offered: a 'none' line (Stab-lok, Leviton) hides
  // Tandem/Quad entirely; 'marked' allows them with a "marked slots only" note; a quad:false line
  // hides Quad. A blank/legacy panel has no mode and behaves as before (all offered).
  const tandemsOffered = () => panelOffersTandems(panel, tandemsAllowed());
  const quadOffered = () => panelOffersQuad(panel, tandemsAllowed());
  const tandemsMarked = () => tandemsOffered() && tandemsModeOf(panel) === 'marked';
  const constructionTypeKeys = () => (tandemsOffered() ? PT.CONSTRUCTION_TYPE_KEYS : PT.CONSTRUCTION_TYPE_KEYS.filter((k) => k !== 'tandem'));
  /** Toast reason when a tandem/quad can't be added here (no neutral, or the line refuses them), else null. */
  const tandemBlockReason = () => {
    if (!tandemsAllowed()) return `${S.systemOf(panel.voltage).label} has no neutral: tandems are single-pole and can't be used.`;
    if (tandemsModeOf(panel) === 'none') return `${panel.line ? panel.line + ' panels do' : 'This panel line does'} not accept tandem or quad breakers.`;
    return null;
  };

  /** Add a full-space breaker of `poles` poles (default: the system's minimum) at `slot`, then put
   *  the cursor in its DESCRIPTION cell. The size starts blank: the AMP cell is filled in like the sheet. */
  function addCircuit(slot, poles = S.minPoles(panel.voltage)) {
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    if (!fits(slot, poles)) return;
    circuits.push({ slot, description: '', amps: null, poles, loadVA: 0, breakerType: 'standard', phase: '' });
    setCircuits(circuits);
    focusCircuit(slot, null);
  }

  /** Add a tandem (half-space, single-pole) breaker to space `slot`; picks the first free half if `half` is omitted. */
  function addTandem(slot, half) {
    if (!tandemsOffered()) { ui.toast(tandemBlockReason(), 'error', 3600); return; }
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    const occ = occupancy(circuits);
    const o = occ.get(slot);
    const letter = half || (o && o.A ? 'B' : 'A');
    const r = placement(circuits, { slot, half: letter }, slotCount(panel));
    if (!r.ok) { ui.toast(r.reason, 'error'); return; }
    circuits.push({ slot, half: letter, description: '', amps: null, poles: 1, loadVA: 0, breakerType: 'tandem', phase: '' });
    setCircuits(circuits);
    focusCircuit(slot, letter);
  }

  /** Add a quad (space-saver): one device laid out as three circuits across two spaces — an outer
   *  single (this space's 'A'), the inner handle-tied 2-pole (this space's 'B' reaching the next
   *  space's 'A'), and an outer single (the next space's 'B'). Each is independently editable; the
   *  inner is a real 2-pole (breakerType 'quad'), not a tandem. */
  function addQuad(slot) {
    if (!quadOffered()) { ui.toast(tandemBlockReason() || `${panel.line ? panel.line + ' panels do' : 'This panel line does'} not take space-saver quads.`, 'error', 3600); return; }
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    const r = placement(circuits, { slot, half: 'B', poles: 2 }, slotCount(panel));
    if (!r.ok) { ui.toast(r.reason, 'error'); return; }
    circuits.push(...quadCircuits(slot));
    setCircuits(circuits);
    focusCircuit(slot, 'A');
  }

  /** What can go in an empty space: tapped from its CCT. NO cell. */
  function openSpaceMenu(slot) {
    const three = S.systemOf(panel.voltage).three;
    const total = slotCount(panel);
    const minP = S.minPoles(panel.voltage);
    const item = (label, note, fn) => h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); fn(); } },
      h('strong', null, label), note ? h('span', { class: 'muted' }, note) : null);
    const sheet = ui.openSheet({
      title: `Space ${slot}`,
      body: h('div', { class: 'tpl-list' },
        minP === 1 ? item('Breaker', 'Single-pole, full space', () => addCircuit(slot, 1)) : null,
        slot + 2 <= total ? item('2-pole breaker', `Spaces ${slot} and ${slot + 2}`, () => addCircuit(slot, 2)) : null,
        three && slot + 4 <= total ? item('3-pole breaker', `Spaces ${slot}, ${slot + 2} and ${slot + 4}`, () => addCircuit(slot, 3)) : null,
        tandemsOffered() ? item('Tandem (split A / B)', tandemsMarked() ? 'Only in slots the panel marks for tandems — check the label' : `Two half-size breakers: ${slot}A and ${slot}B`, () => addTandem(slot, 'A')) : null,
        quadOffered() && slot + 2 <= total ? item('Quad (space-saver)', `Two singles and a 2-pole across ${slot} and ${slot + 2}`, () => addQuad(slot)) : null,
        item('From a template…', 'Size, type, poles and description in one tap', () => openTemplatePicker(slot))),
    });
  }

  /** An empty half of a split space: add a tandem there, or put the space back to full size. */
  function openHalfMenu(slot, half) {
    const o = occupancy(panel.circuits || []).get(slot) || {};
    const other = o[half === 'A' ? 'B' : 'A'];
    const canMerge = other && !isQuadInner(other) && makeFullSpace((panel.circuits || []).map((x) => ({ ...x })), { ...other });
    const item = (label, note, fn) => h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); fn(); } },
      h('strong', null, label), note ? h('span', { class: 'muted' }, note) : null);
    const sheet = ui.openSheet({
      title: `Space ${slot}${half}`,
      body: h('div', { class: 'tpl-list' },
        item(`Tandem ${slot}${half}`, 'Half-size single-pole breaker', () => addTandem(slot, half)),
        item('From a template…', null, () => openTemplatePicker(slot, half)),
        canMerge ? item('Make it one full-size space', `${slot}${other.half}${other.description ? ' · ' + other.description : ''} becomes a full-size breaker`, () => {
          const circuits = panel.circuits.map((x) => ({ ...x }));
          const cur = circuits.find((x) => sameCircuit(x, other));
          if (cur && makeFullSpace(circuits, cur)) setCircuits(circuits);
        }) : null),
    });
  }

  /** Turn a full single-pole breaker into a half tandem in place; returns true on success, else toasts. */
  function makeTandem(cur, circuits) {
    if (halfOf(cur)) { cur.breakerType = 'tandem'; return true; } // already a half
    if ((Number(cur.poles) || 1) > 1) { ui.toast("Multi-pole breakers fill a full space and can't be tandems.", 'error'); return false; }
    if (!tandemsOffered()) { ui.toast(tandemBlockReason(), 'error'); return false; }
    const occ = occupancy(circuits.filter((x) => x !== cur));
    const o = occ.get(Number(cur.slot));
    const letter = !(o && o.A) ? 'A' : (!o.B ? 'B' : null);
    if (!letter) { ui.toast(`Space ${cur.slot} already has two tandems.`, 'error'); return false; }
    cur.half = letter; cur.poles = 1; cur.breakerType = 'tandem';
    return true;
  }

  /** True if a full breaker of `poles` poles can sit at `slot` (room below, not past the end, pole rules). Toasts why not. */
  function fits(slot, poles) {
    const three = S.systemOf(panel.voltage).three;
    if (poles === 3 && !three) { ui.toast('3-pole breakers need a three-phase panel.', 'error'); return false; }
    if (poles < S.minPoles(panel.voltage)) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: use a 2- or 3-pole breaker.`, 'error'); return false; }
    const r = placement(panel.circuits || [], { slot, poles }, slotCount(panel));
    if (!r.ok) { ui.toast(r.reason, 'error'); return false; }
    return true;
  }

  /** Place a breaker template at a slot, filling poles/amps/loadVA/description/type in one tap. A tandem
   * template (breakerType 'tandem') lands in a half space, taking `preferHalf` or the first free half. */
  function placeTemplate(slot, tpl, preferHalf) {
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    if (tpl.quad) {
      if (!quadOffered()) { ui.toast(tandemBlockReason() || `${panel.line ? panel.line + ' panels do' : 'This panel line does'} not take space-saver quads.`, 'error', 3600); return; }
      const r = placement(circuits, { slot, half: 'B', poles: 2 }, slotCount(panel));
      if (!r.ok) { ui.toast(r.reason, 'error'); return; }
      // A quad template fills all three circuits of the device: the inner 2-pole takes the template's
      // amp/load/description; the two outer singles start blank for the user to fill in.
      const [top, inner, bottom] = quadCircuits(slot);
      const base = PT.applyBreakerTemplate(tpl, { slot, poles: 2, amps: 20, loadVA: 0 });
      circuits.push(top, { ...inner, ...base, slot, half: 'B', poles: 2, breakerType: 'quad', phase: '' }, bottom);
      setCircuits(circuits);
      return;
    }
    if (tpl.breakerType === 'tandem' || tpl.half) {
      if (!tandemsOffered()) { ui.toast(tandemBlockReason(), 'error', 3600); return; }
      const o = occupancy(circuits).get(slot);
      const letter = preferHalf && !(o && o[preferHalf]) ? preferHalf : (!(o && o.A) ? 'A' : (!o.B ? 'B' : null));
      if (!letter) { ui.toast(`Space ${slot} already has two tandems.`, 'error'); return; }
      const r = placement(circuits, { slot, half: letter }, slotCount(panel));
      if (!r.ok) { ui.toast(r.reason, 'error'); return; }
      const base = PT.applyBreakerTemplate(tpl, { slot, poles: 1, amps: 20, loadVA: 0 });
      circuits.push({ ...base, slot, half: letter, poles: 1, breakerType: 'tandem', phase: '' });
      setCircuits(circuits);
      return;
    }
    let poles = Number(tpl.poles) || S.minPoles(panel.voltage);
    if (poles < S.minPoles(panel.voltage)) poles = S.minPoles(panel.voltage); // honour a no-neutral system
    if (!fits(slot, poles)) return;
    const base = PT.applyBreakerTemplate(tpl, { slot, poles, amps: 20, loadVA: 0 });
    circuits.push({ ...base, slot, poles, phase: '' });
    setCircuits(circuits);
  }

  function openTemplatePicker(slot, preferHalf) {
    // Tandem templates are single-pole half-space breakers; a no-neutral system can't use them, so
    // hide them here the same way the empty-cell UI hides the Tandem button.
    const templates = PT.listBreakerTemplates(store.settings()).filter((t) => (t.quad ? quadOffered() : (t.breakerType === 'tandem' ? tandemsOffered() : true)));
    const groups = [...new Set(templates.map((t) => t.group || 'Other'))];
    const sheet = ui.openSheet({
      title: `Breaker template · space ${slot}${preferHalf ? ' ' + preferHalf : ''}`,
      body: h('div', { class: 'tpl-groups' }, groups.map((g) => h('div', { class: 'tpl-group' },
        h('div', { class: 'tpl-group-head' }, g),
        templates.filter((t) => (t.group || 'Other') === g).map((t) => h('div', { class: 'tpl-row' },
          h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); placeTemplate(slot, t, preferHalf); } },
            h('strong', null, t.label),
            h('span', { class: 'muted' }, `${t.quad ? 'quad · 2P inner' : (t.breakerType === 'tandem' ? 'half · 1P' : t.poles + 'P')} · ${t.amps == null ? '—' : t.amps + ' A'} · ${PT.breakerTypeLabel(t.breakerType)}${t.loadVA == null ? '' : ' · ' + ui.fmtNum(t.loadVA) + ' VA'}`)),
          t.custom ? ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Delete template', onClick: () => { PT.removeBreakerTemplate(store, t.id); sheet.close(); openTemplatePicker(slot, preferHalf); } }) : null))))),
    });
  }

  /** Per-circuit options sheet: save as template, sub-feed, breaker type, colour override. */
  function openCircuitOptions(c) {
    const colours = coloursNow();
    const pp = panelPrintSettings(store.settings());
    const quadInner = isQuadInner(c);
    const phaseKeys = (c.phase || S.circuitPhases(c.slot, phasePolesOf(c), panel.voltage)).split('-');
    const typeOptions = constructionTypeKeys().map((k) => ({ value: k, label: PT.BREAKER_TYPES[k] }));
    const phaseOptions = [{ value: '', label: 'By phase (default)' }, ...Object.keys(colours.phases).map((p) => ({ value: p, label: `Phase ${p} · ${colours.phases[p].name}` }))];
    // Row-highlight choices. '' keeps the default (red for a smoke/alarm purpose, none otherwise).
    const highlightOptions = [
      { value: '', label: 'Default (red for smoke / alarm)' },
      { value: 'none', label: 'No highlight' },
      { value: pp.smokeColor, label: 'Smoke red' },
      { value: '#f59e0b', label: 'Amber' },
      { value: '#16a34a', label: 'Green' },
      { value: '#2563eb', label: 'Blue' },
    ];
    const curHex = c.colorOverride === 'none' || /^#[0-9a-f]{6}$/i.test(c.colorOverride || '') ? c.colorOverride : '';
    const curPhase = c.colorOverride && colours.phases[c.colorOverride] ? c.colorOverride : '';
    const isHalf = !!halfOf(c);
    const siblingEmpty = isHalf && makeFullSpace((panel.circuits || []).map((x) => ({ ...x })), { ...c });
    const partInfo = partOf(c);
    const poleOptions = [1, 2, 3].filter((p) => p >= S.minPoles(panel.voltage) && (p < 3 || S.systemOf(panel.voltage).three)).map((p) => ({ value: String(p), label: `${p}-pole` }));
    const sheet = ui.formSheet({
      title: `Breaker ${c.slot}${halfOf(c) || ''}${c.description ? ' · ' + c.description : ''}`,
      fields: [
        ...(isHalf ? [] : [{ label: 'Poles', name: 'poles', type: 'select', value: String(Number(c.poles) || 1), options: poleOptions, hint: 'A 2-pole takes this space and the next one on the same side' }]),
        { label: 'Load (VA)', name: 'loadVA', type: 'number', value: Number(c.loadVA) || '', min: 0, step: 'any', placeholder: '0', hint: 'For phase balance and the load summary' },
        quadInner
          ? { label: 'Breaker type', name: 'breakerTypeShown', type: 'text', value: 'Quad 2-pole (space-saver)', readonly: true, hint: 'A quad’s inner handle-tied 2-pole. The two outer singles are separate breakers.' }
          : { label: 'Breaker type', name: 'breakerType', type: 'select', value: c.breakerType || 'standard', options: typeOptions, hint: isHalf ? null : (tandemsOffered() ? 'Tandem splits the space into A / B halves' : null) },
        ...(partInfo ? [{ label: 'Breaker part no.', name: 'partNo', type: 'text', value: c.partNoManual ? (c.partNo || '') : partInfo.number, placeholder: partInfo.number || 'part no.', hint: c.partNoManual ? 'Manual override — clear it to use the catalogue number' : (partInfo.confident ? `From the ${panel.line || 'panel'} line` : (partInfo.note || 'Verify against the stamped breaker')) }] : []),
        { label: 'Purpose tag', name: 'purpose', type: 'text', value: c.purpose || '', placeholder: 'e.g. smoke, kitchen, lighting', hint: '“smoke” or “alarm” is highlighted red by default' },
        { label: 'Wiring status', name: 'status', type: 'select', value: c.status || '', options: [{ value: '', label: 'Not tracked' }, ...PANEL_STATUSES.map((s) => ({ value: s.key, label: s.label }))] },
        { label: 'Row highlight', name: 'highlight', type: 'select', value: curHex, options: highlightOptions },
        { label: 'Phase colour shown', name: 'colorShown', type: 'select', value: curPhase, options: phaseOptions },
        { label: 'Sub-feed / feeder breaker', name: 'subFeed', type: 'checkbox', value: !!c.subFeed, span: true },
      ],
      submitLabel: 'Apply',
      danger: { label: 'Remove breaker', onClick: () => removeCircuit(c) },
      extra: h('div', { class: 'tpl-save-row' },
        h('span', { class: 'muted small' }, `Phases ${phaseKeys.join('-')}`),
        h('div', { class: 'row' },
          siblingEmpty ? ui.button('Make full-space', { variant: 'ghost', icon: 'square', title: 'Convert this tandem back to a full-size breaker', onClick: () => {
            const circuits = panel.circuits.map((x) => ({ ...x }));
            const cur = circuits.find((x) => sameCircuit(x, c));
            if (cur && makeFullSpace(circuits, cur)) { sheet.close(); setCircuits(circuits); }
            else ui.toast('The other half of this space must be empty first.', 'error');
          } }) : null,
          ui.button('Save as template', { variant: 'ghost', icon: 'save', onClick: async () => {
            const label = await ui.promptDialog('Template name', { title: 'Save as template', value: c.description || 'Custom breaker', okLabel: 'Save' });
            if (label == null) return;
            PT.saveBreakerTemplate(store, { label, poles: c.poles, amps: c.amps, loadVA: c.loadVA, breakerType: c.breakerType || 'standard', descriptionDefault: c.description || '', subFeed: c.subFeed, group: 'Company' });
            ui.toast('Saved as a company template', 'success');
          } }))),
      onSubmit: (v) => {
        const circuits = panel.circuits.map((x) => ({ ...x }));
        const cur = circuits.find((x) => sameCircuit(x, c));
        if (!cur) return;
        // Poles first (a full breaker only): it must fit the system and the spaces on its side.
        if (!isHalf && v.poles && Number(v.poles) !== (Number(cur.poles) || 1)) {
          const poles = Number(v.poles);
          const r = placement(circuits.filter((x) => x !== cur), { slot: cur.slot, poles }, slotCount(panel));
          if (!r.ok) { ui.toast(r.reason, 'error'); return false; }
          cur.poles = poles;
        }
        cur.loadVA = Math.max(0, Number(v.loadVA) || 0);
        // A quad inner keeps its 'quad' type (its control is read-only); everything else sets its type,
        // with 'tandem' converting a full breaker to a half.
        if (!quadInner) {
          const bt = v.breakerType || 'standard';
          if (bt === 'tandem') { if (!makeTandem(cur, circuits)) return false; }
          else cur.breakerType = bt;
        }
        cur.purpose = (v.purpose || '').trim().slice(0, 40) || null;
        cur.status = v.status || null;
        // A chosen highlight ('none' or a #hex) wins; otherwise fall back to the phase-colour override.
        cur.colorOverride = v.highlight ? v.highlight : (v.colorShown || null);
        cur.subFeed = !!v.subFeed;
        // Part number: a typed value that differs from the catalogue number (old or freshly resolved)
        // is a manual override that wins; clearing it or matching the catalogue reverts to auto.
        if (partInfo) {
          const v2 = String(v.partNo || '').trim();
          const auto = circuitPartNumber(panel, cur, circuits);
          if (!v2 || v2 === partInfo.number || (auto && auto.number === v2)) { delete cur.partNo; delete cur.partNoManual; }
          else { cur.partNo = v2; cur.partNoManual = true; }
        }
        setCircuits(circuits);
      },
    });
    return sheet;
  }

  const coloursNow = () => S.systemColours(bookOf(), panel.voltage, store.settings().panelColours);

  async function removeCircuit(c) {
    if (!(await ui.confirmDialog(`Remove breaker ${c.slot}${halfOf(c) || ''}${c.description ? ` (${c.description})` : ''}?`, { okLabel: 'Remove' }))) return;
    setCircuits(panel.circuits.filter((x) => !sameCircuit(x, c)));
  }

  // -------------------------------------------------------------------------
  // The sheet: the schedule as the company's spreadsheet, edited cell by cell
  // -------------------------------------------------------------------------

  const uid = () => (ctx.auth && ctx.auth.current ? (ctx.auth.current() || {}).id : undefined);
  const sheetSet = () => PS.sheetSettings(store.settings());
  /** CCT. NO fills by leg: the company's phase bands, or plain white when bands are switched off. */
  const legFills = (pp) => {
    const out = {};
    for (const p of ['A', 'B', 'C']) out[p] = pp.phaseBandsOn ? (pp.phaseBands[p] || PS.SHEET_LEG_DEFAULTS[p]) : '#ffffff';
    return out;
  };
  /** The layout for the screen (empty spaces whole) or for paper / .xlsx (empty spaces split A/B
   *  like the blank template, when the panel takes tandems). */
  const layoutFor = (paper) => {
    const ss = sheetSet();
    return PS.sheetLayout(panel, { evenLeft: ss.evenLeft, bottomUp: ss.bottomUp, splitEmpty: paper, tandems: tandemsOffered() });
  };
  let sheetNow = null; // the layout the on-screen grid was drawn from
  const EDIT_COLS = [0, 2, 3, 5];
  const AMP_CHOICES = ['15', '15 AFI', '20', '20 AFI', '15 GFI', '20 GFI', '30', '40', '50', '60', '15 DF', '20 DF', '70', '80', '90', '100', '125', '150', '200'];

  const cellLabel = (cell) => `${cell.kind === 'desc' ? 'Description' : cell.kind === 'amp' ? 'Breaker size' : 'Circuit'} ${cell.slot}${cell.half || ''}`;
  /** Classes for a sheet cell: kind, state, leg, dotted A/B edges, the centre double rule. */
  function cellClasses(cell, hl) {
    return ['ps-' + cell.kind, 'ps-st-' + cell.state,
      cell.kind === 'cct' ? 'ps-leg-' + cell.leg : null,
      cell.r % 2 === 1 ? 'ps-dt' : null,
      (cell.r + cell.span) % 2 === 1 ? 'ps-db' : null,
      cell.col === 2 ? 'ps-mid-l' : cell.col === 3 ? 'ps-mid-r' : null,
      cell.span > 1 ? 'ps-tall' : null,
      hl ? 'ps-hl' : null].filter(Boolean).join(' ');
  }
  const cellHighlight = (cell, pp) => (cell.kind === 'desc' && cell.circuit ? highlightFor(cell.circuit, pp) : null);
  /** What a paper cell prints: the amps can be hidden, and the wiring status shown. */
  function paperText(cell, pp) {
    if (cell.kind === 'amp' && !pp.showAmps) return '';
    if (cell.kind === 'desc' && cell.circuit && pp.showStatus && cell.circuit.status) {
      return [cell.text, h('span', { class: 'ps-status' }, ` · ${PANEL_STATUS_LABEL(cell.circuit.status)}`)];
    }
    return cell.text;
  }

  function sheetCell(cell, i, { editable, pp }) {
    const hl = cellHighlight(cell, pp);
    const props = { class: cellClasses(cell, hl), rowspan: cell.span > 1 ? cell.span : null, dataset: { i, r: cell.r, col: cell.col, span: cell.span } };
    if (hl) props.style = { backgroundColor: PS.tint(hl, 0.75) };
    if (cell.kind === 'cct') {
      return h('td', props, editable
        ? h('button', { type: 'button', class: 'ps-num', title: cell.circuit ? 'Breaker options' : 'Add a breaker here', 'aria-label': `${cellLabel(cell)}${cell.circuit ? ' options' : ', add a breaker'}`, onClick: () => openCellMenu(cell) }, cell.text)
        : cell.text);
    }
    if (!editable) return h('td', props, paperText(cell, pp));
    return h('td', props, h('input', {
      class: 'ps-in', name: cell.kind, value: cell.text, dataset: { orig: cell.text }, autocomplete: 'off', autocorrect: 'off',
      spellcheck: 'false', enterkeyhint: 'next', 'aria-label': cellLabel(cell),
    }));
  }

  /** The logo block under the sheet: the company's own logo (or its name) and contact line. */
  function logoBlock({ qr }) {
    const co = store.settings().company || {};
    const contact = [co.phone, co.website, co.email].map((x) => String(x || '').trim()).filter(Boolean);
    const brand = co.logo
      ? h('img', { class: 'ps-logo', src: co.logo, alt: co.name || 'Company logo' })
      : (co.name ? h('div', { class: 'ps-logo-name' }, co.name) : null);
    return h('tbody', { class: 'ps-foot' }, h('tr', null,
      h('td', { class: 'ps-logo-cell', colspan: 6 },
        h('div', { class: 'ps-logo-box' },
          brand,
          sheetSet().contactLine && contact.length ? h('div', { class: 'ps-contact' }, contact.join('   ·   ')) : null,
          qr ? h('div', { class: 'ps-qr' }, qrSvgNode(thisPanelUrl(), { label: `Open panel ${panel.name}` })) : null)),
      h('td', { class: 'ps-rh' })));
  }

  /** The schedule as a table in the template's layout: editable on screen, plain on paper. */
  function sheetTable(layout, { editable, qr = false }) {
    const pp = panelPrintSettings(store.settings());
    const fills = legFills(pp);
    const table = h('table', { class: ['ps-table', editable ? 'ps-live' : 'ps-paper'] });
    // Leg fills arrive as CSS variables the ps-leg-* classes read (CSSOM, so CSP-safe).
    for (const p of Object.keys(fills)) {
      table.style.setProperty('--ps-leg-' + p, fills[p]);
      table.style.setProperty('--ps-leg-' + p + '-fg', PS.inkOn(fills[p]));
    }
    const titleVal = (name, value, label) => (editable
      ? h('input', { class: 'ps-in ps-title-in', name, value, dataset: { orig: value }, autocomplete: 'off', enterkeyhint: 'next', 'aria-label': label })
      : value);
    const rh = () => h('td', { class: 'ps-rh', 'aria-hidden': 'true' });
    const colgroup = h('colgroup', null, ['desc', 'cct', 'amp', 'amp', 'cct', 'desc'].map((k) => h('col', { class: 'ps-col-' + k })), h('col', { class: 'ps-col-rh' }));
    const thead = h('thead', null,
      h('tr', { class: 'ps-title' }, h('th', { class: 'ps-tl', scope: 'row' }, 'PANEL NAME'), h('td', { class: 'ps-tv', colspan: 5 }, titleVal('pname', panel.name || '', 'Panel name')), rh()),
      h('tr', { class: 'ps-title' }, h('th', { class: 'ps-tl', scope: 'row' }, 'PANEL LOCATION'), h('td', { class: 'ps-tv', colspan: 5 }, titleVal('plocation', panel.location || '', 'Panel location')), rh()),
      h('tr', { class: 'ps-title' }, h('td', { class: 'ps-svc', colspan: 6 }, PS.sheetServiceLine(panel)), rh()),
      h('tr', { class: 'ps-colhead' }, PS.SHEET_HEADERS.map((t, i) => h('th', { scope: 'col', class: i === 2 ? 'ps-mid-l' : i === 3 ? 'ps-mid-r' : null }, t)), rh()));
    const tbody = h('tbody', { class: 'ps-body' });
    for (let r = 0; r < layout.rows; r++) {
      const tr = h('tr');
      for (let col = 0; col < 6; col++) {
        const i = layout.cover[r][col];
        if (i < 0) { tr.append(h('td', { class: 'ps-void' })); continue; }
        const cell = layout.cells[i];
        if (cell.r === r) tr.append(sheetCell(cell, i, { editable, pp }));
      }
      // A zero-width cell on every row keeps each sheet row its full height even when every other
      // cell in it is spanned from the row above (an all-rowspan <tr> collapses otherwise).
      tr.append(rh());
      tbody.append(tr);
    }
    table.append(colgroup, thead, tbody, logoBlock({ qr }));
    return table;
  }

  const pickEl = h('div', { class: 'ps-pick', role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
  let pickInput = null;
  let pickItems = [];
  let pickIdx = -1;
  let pickSuppressed = ''; // 'r:col' of a cell whose list was just used or dismissed, until typing resumes
  let pickTyped = false;   // arrows drive the list only once the person has typed; before that they move cells

  function drawSheet() {
    hidePick();
    ui.clear(gridEl);
    const ss = sheetSet();
    sheetNow = layoutFor(false);
    const seg = (label, on, title, fn) => h('button', { type: 'button', class: ['ps-seg-btn', on ? 'on' : null], 'aria-pressed': String(on), title, onClick: fn }, label);
    const setSheet = (patch) => {
      const cur = (store.settings().panelSheet && typeof store.settings().panelSheet === 'object') ? store.settings().panelSheet : {};
      store.saveSettings({ panelSheet: { ...cur, ...patch } });
      redraw();
    };
    // .filter(Boolean): native append() would print a missing line note as the text "null".
    gridEl.append(...[
      h('div', { class: 'ps-toolbar' },
        h('div', { class: 'ps-seg', role: 'group', 'aria-label': 'Side for even circuits' },
          seg('Even left', ss.evenLeft, 'Even circuits on the left, odd on the right (the template)', () => setSheet({ evenLeft: true })),
          seg('Odd left', !ss.evenLeft, 'Odd circuits on the left, even on the right', () => setSheet({ evenLeft: false }))),
        h('div', { class: 'ps-seg', role: 'group', 'aria-label': 'Numbering direction' },
          seg('1 at bottom', ss.bottomUp, 'Circuits 1 and 2 at the bottom, counting up (the template)', () => setSheet({ bottomUp: true })),
          seg('1 at top', !ss.bottomUp, 'Circuits 1 and 2 at the top, counting down', () => setSheet({ bottomUp: false }))),
        h('span', { class: 'grow' }),
        ui.button('Excel', { size: 'sm', icon: 'download', title: 'Download this schedule as an Excel file (.xlsx)', onClick: exportXlsx }),
        ui.button('Google Sheets', { size: 'sm', variant: 'ghost', icon: 'info', title: 'How to open the schedule in Google Sheets', onClick: openGoogleHint })),
      (panel.breakerFamily || panel.line) ? h('div', { class: 'panel-line-note muted small' },
        ui.icon('info', 14), ' ',
        `${panel.manufacturer ? panel.manufacturer + ' ' : ''}${panel.line || ''}${panel.breakerWidth ? ' · ' + panel.breakerWidth + ' breakers' : ''}`,
        tandemsModeOf(panel) === 'none' ? ' · no tandems or quads' : null,
        tandemsMarked() ? ' · tandems only in slots the panel marks for them — check the label' : null) : null,
      h('div', { class: 'ps-scroll' }, sheetTable(sheetNow, { editable: true }), pickEl),
      h('p', { class: 'ps-hint muted small' },
        'Tap a cell and type. Enter moves down, Tab moves across. Sizes: 15, 20 AFI, 20 GFI, 40 2P. ',
        'Tap a circuit number to add a 2-pole, split a space A / B, set the breaker type or load, or remove it.'),
    ].filter(Boolean));
  }

  /** After an edit: patch the cells in place when the sheet's shape is unchanged (keeps the focused
   *  input, and so the iPad keyboard), else rebuild it. Returns true when patched in place. */
  function refreshSheet() {
    drawSummary(); drawPrint(); drawLabel(); syncHead();
    const next = layoutFor(false);
    const shape = (L) => L.cells.map((c) => `${c.kind}${c.col}:${c.r}+${c.span}`).join('|');
    const table = gridEl.querySelector('table.ps-live');
    if (!sheetNow || !table || shape(next) !== shape(sheetNow)) { drawSheet(); return false; }
    sheetNow = next;
    const pp = panelPrintSettings(store.settings());
    for (const td of table.querySelectorAll('td[data-i]')) {
      const cell = next.cells[Number(td.dataset.i)];
      if (!cell) continue;
      const hl = cellHighlight(cell, pp);
      td.className = cellClasses(cell, hl);
      td.style.backgroundColor = hl ? PS.tint(hl, 0.75) : '';
      const inp = td.querySelector('input');
      if (inp) {
        if (document.activeElement !== inp || inp.value.trim() === (inp.dataset.orig || '')) inp.value = cell.text;
        inp.dataset.orig = cell.text;
      }
      const btn = td.querySelector('button.ps-num');
      if (btn) btn.setAttribute('aria-label', `${cellLabel(cell)}${cell.circuit ? ' options' : ', add a breaker'}`);
    }
    for (const [name, value] of [['pname', panel.name || ''], ['plocation', panel.location || '']]) {
      const inp = table.querySelector(`input[name=${name}]`);
      if (inp && document.activeElement !== inp) { inp.value = value; inp.dataset.orig = value; }
    }
    const svc = table.querySelector('.ps-svc');
    if (svc) svc.textContent = PS.sheetServiceLine(panel);
    return true;
  }

  /** Keep the details form, and the page title, in step with names typed into the sheet. */
  function syncHead() {
    for (const [name, value] of [['name', panel.name || ''], ['location', panel.location || '']]) {
      const el = head.querySelector(`[name=${name}]`);
      if (el && document.activeElement !== el) el.value = value;
    }
    const h1 = root.querySelector('.page-head h1');
    if (h1) h1.textContent = panel.name || 'Panel';
  }

  /** Put the cursor in the cell covering sheet row r, column col. */
  function focusCell(r, col, select) {
    const L = sheetNow;
    if (!L || r < 0 || r >= L.rows) return false;
    const i = L.cover[r][col];
    if (i == null || i < 0) return false;
    const td = gridEl.querySelector(`td[data-i="${i}"]`);
    const el = td && (td.querySelector('input') || td.querySelector('button'));
    if (!el) return false;
    el.focus();
    if (select && typeof el.select === 'function') { try { el.select(); } catch { /* not selectable */ } }
    return true;
  }

  /** Focus a circuit's DESCRIPTION cell (after adding it from a menu). */
  function focusCircuit(slot, half) {
    const L = sheetNow;
    const cell = L && L.cells.find((c) => c.kind === 'desc' && c.slot === Number(slot) && (half ? c.half === half : !c.half));
    if (cell) focusCell(cell.r, cell.col, false);
  }

  /** Where Enter / Tab / arrows go from a cell: down and up by sheet row, across in reading order. */
  function navTarget(td, dir) {
    const L = sheetNow;
    const r = Number(td.dataset.r);
    const col = Number(td.dataset.col);
    const span = Number(td.dataset.span) || 1;
    if (dir === 'down') return r + span < L.rows ? { r: r + span, col } : null;
    if (dir === 'up') return r > 0 ? { r: r - 1, col } : null;
    const order = [];
    for (let rr = 0; rr < L.rows; rr++) {
      for (const c of EDIT_COLS) { const i = L.cover[rr][c]; if (i >= 0 && L.cells[i].r === rr) order.push({ r: rr, col: c, i }); }
    }
    const at = order.findIndex((o) => o.i === Number(td.dataset.i));
    const nx = at < 0 ? null : order[at + (dir === 'right' ? 1 : -1)];
    return nx ? { r: nx.r, col: nx.col } : null;
  }

  /**
   * Apply one typed cell to the circuits. Typing into an empty space makes a breaker there (a
   * tandem in an empty half); clearing the last thing on a single-pole breaker empties the space
   * again. Returns the new circuits, or null when nothing should change (with a toast saying why).
   */
  function editCell(cell, value) {
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    let cur = cell.circuit ? circuits.find((x) => sameCircuit(x, cell.circuit)) : null;
    const amp = cell.kind === 'amp' ? PS.parseAmpText(value) : null;
    if (amp && value && !amp.amps) { ui.toast('Type the breaker size, like 15, 20 AFI or 40 2P.', 'error', 3600); return null; }
    if (!cur) {
      if (!value) return null;
      if (cell.state === 'emptyHalf') {
        if (!tandemsOffered()) { ui.toast(tandemBlockReason(), 'error', 3600); return null; }
        const r = placement(circuits, { slot: cell.slot, half: cell.half }, slotCount(panel));
        if (!r.ok) { ui.toast(r.reason, 'error'); return null; }
        cur = { slot: cell.slot, half: cell.half, description: '', amps: null, poles: 1, loadVA: 0, breakerType: 'tandem', phase: '' };
      } else {
        const poles = Math.max(S.minPoles(panel.voltage), (amp && amp.poles) || 1);
        if (!fits(cell.slot, poles)) return null;
        cur = { slot: cell.slot, description: '', amps: null, poles, loadVA: 0, breakerType: 'standard', phase: '' };
      }
      circuits.push(cur);
    }
    if (cell.kind === 'desc') {
      cur.description = value.slice(0, 300);
      if (value) noteUse('panels.descriptions', value.toLowerCase(), { uid: uid() });
    } else {
      cur.amps = amp.amps;
      if (!isQuadInner(cur)) {
        if (amp.breakerType) cur.breakerType = amp.breakerType;
        else if (['afci', 'gfci', 'dual'].includes(cur.breakerType)) cur.breakerType = halfOf(cur) ? 'tandem' : 'standard';
      }
      if (amp.poles && !halfOf(cur) && amp.poles !== (Number(cur.poles) || 1)) {
        if (amp.poles === 3 && !S.systemOf(panel.voltage).three) { ui.toast('3-pole breakers need a three-phase panel.', 'error'); return null; }
        const r = placement(circuits.filter((x) => x !== cur), { slot: cur.slot, poles: amp.poles }, slotCount(panel));
        if (!r.ok) { ui.toast(r.reason, 'error'); return null; }
        cur.poles = amp.poles;
      }
      if (value) noteUse('panels.amps', PS.sheetAmpText(cur), { uid: uid() });
    }
    const blank = !String(cur.description || '').trim() && !Number(cur.amps) && !Number(cur.loadVA) && !cur.subFeed && !cur.purpose;
    const simple = !isQuadInner(cur) && (halfOf(cur) || (Number(cur.poles) || 1) === 1);
    return blank && simple ? circuits.filter((x) => x !== cur) : circuits;
  }

  /** Save one input if it changed. Returns true when the panel was updated. */
  function commitInput(inp) {
    const v = inp.value.replace(/\s+/g, ' ').trim();
    if (v === (inp.dataset.orig || '')) return false;
    inp.dataset.orig = v;
    if (inp.name === 'pname' || inp.name === 'plocation') {
      panel = store.update('panels', panel.id, inp.name === 'pname' ? { name: v.slice(0, 200) || 'Panel' } : { location: v.slice(0, 200) || null });
      return true;
    }
    const td = inp.closest('td[data-i]');
    const cell = td && sheetNow ? sheetNow.cells[Number(td.dataset.i)] : null;
    if (!cell) return false;
    const circuits = editCell(cell, v);
    if (!circuits) { inp.value = cell.text; inp.dataset.orig = cell.text; return false; }
    panel = store.update('panels', panel.id, { circuits: applyPartNumbers(panel, withPhases(circuits, panel.voltage)) });
    return true;
  }

  /** Redraw after a commit, then put the cursor at `target` ({ r, col }), or — after a tap moved
   *  focus elsewhere — back on whatever cell now has it. */
  function afterCommit(target) {
    if (target) {
      refreshSheet();
      focusCell(target.r, target.col, true);
      return;
    }
    setTimeout(() => {
      const a = document.activeElement;
      const td = a && gridEl.contains(a) ? a.closest('td[data-i]') : null;
      const at = td ? { r: Number(td.dataset.r), col: Number(td.dataset.col) } : null;
      const title = a && gridEl.contains(a) && a.classList.contains('ps-title-in') ? a.name : '';
      if (refreshSheet()) return;
      if (at) focusCell(at.r, at.col, false);
      else if (title) gridEl.querySelector(`input[name=${title}]`)?.focus();
    }, 0);
  }

  function openCellMenu(cell) {
    if (cell.circuit) { openCircuitOptions(cell.circuit); return; }
    if (cell.state === 'emptyHalf') { openHalfMenu(cell.slot, cell.half); return; }
    openSpaceMenu(cell.slot);
  }

  // --- the pick-list under a cell: descriptions and breaker sizes, most-used first ---

  function hidePick() { pickEl.hidden = true; pickInput = null; pickItems = []; pickIdx = -1; }
  const pickOpen = () => !pickEl.hidden && !!pickInput && document.activeElement === pickInput;
  const coordsOf = (inp) => { const td = inp.closest('td[data-i]'); return td ? `${td.dataset.r}:${td.dataset.col}` : ''; };

  function descChoices() {
    const seen = new Map();
    const add = (n) => { const t = String(n || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
    PT.panelCircuitNames(store.settings()).forEach(add);
    for (const p of store.list('panels')) for (const c of p.circuits || []) add(c.description);
    return rankByUse('panels.descriptions', [...seen.values()], (n) => n.toLowerCase(), { uid: uid() });
  }
  function ampChoices() {
    // The common field sizes first, then this panel's own, then every standard rating up to 400 A.
    const set = new Set(AMP_CHOICES);
    for (const c of panel.circuits || []) { const t = PS.sheetAmpText(c); if (t) set.add(t); }
    for (const a of BREAKERS) set.add(String(a));
    return rankByUse('panels.amps', [...set], (x) => x, { uid: uid() });
  }

  function showPick(inp) {
    if (pickSuppressed && pickSuppressed === coordsOf(inp)) { hidePick(); return; }
    const q = inp.value.trim().toLowerCase();
    const all = inp.name === 'amp' ? ampChoices() : descChoices();
    let list = all.filter((n) => { const k = n.toLowerCase(); return k !== q && (!q || k.includes(q)); });
    if (q) list = [...list.filter((n) => n.toLowerCase().startsWith(q)), ...list.filter((n) => !n.toLowerCase().startsWith(q))];
    list = list.slice(0, 8);
    const scroll = pickEl.parentElement;
    const td = inp.closest('td');
    if (!list.length || !scroll || !td) { hidePick(); return; }
    pickInput = inp; pickItems = list; pickIdx = -1;
    ui.clear(pickEl).append(...list.map((n, k) => h('button', { type: 'button', class: 'ps-pick-item', role: 'option', tabindex: '-1', 'aria-selected': 'false', dataset: { k } }, n)));
    pickEl.hidden = false;
    const sr = scroll.getBoundingClientRect();
    const cr = td.getBoundingClientRect();
    const width = Math.max(cr.width, inp.name === 'amp' ? 112 : 220);
    const left = Math.max(0, Math.min(cr.left - sr.left + scroll.scrollLeft, scroll.scrollWidth - width - 2));
    const below = cr.bottom - sr.top + scroll.scrollTop;
    const above = cr.top - sr.top + scroll.scrollTop - pickEl.offsetHeight;
    const roomBelow = sr.bottom - cr.bottom;
    pickEl.style.minWidth = width + 'px';
    pickEl.style.left = left + 'px';
    pickEl.style.top = (roomBelow < pickEl.offsetHeight && above >= 0 ? above : below) + 'px';
  }
  function movePick(d) {
    if (!pickItems.length) return;
    pickIdx = (pickIdx + d + pickItems.length) % pickItems.length;
    pickEl.querySelectorAll('.ps-pick-item').forEach((b, k) => { b.classList.toggle('on', k === pickIdx); b.setAttribute('aria-selected', String(k === pickIdx)); });
  }
  function choosePick(k) {
    const inp = pickInput;
    const v = pickItems[k];
    if (!inp || v == null) return;
    inp.value = v;
    pickSuppressed = coordsOf(inp);
    hidePick();
    const td = inp.closest('td[data-i]');
    const here = td ? { r: Number(td.dataset.r), col: Number(td.dataset.col) } : null;
    if (commitInput(inp)) afterCommit(here);
  }
  // pointerdown (not click) so the input keeps focus — and the iPad keeps its keyboard up.
  pickEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.ps-pick-item');
    e.preventDefault();
    if (b) choosePick(Number(b.dataset.k));
  });
  pickEl.addEventListener('mousedown', (e) => e.preventDefault());

  function onSheetKey(e) {
    const inp = e.target;
    if (!inp.matches || !inp.matches('input.ps-in')) return;
    if (pickOpen() && (pickTyped || pickIdx >= 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); movePick(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' && pickIdx >= 0) { e.preventDefault(); choosePick(pickIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); pickSuppressed = coordsOf(inp); hidePick(); return; }
    }
    if (e.key === 'Escape') { inp.value = inp.dataset.orig || ''; hidePick(); return; }
    if (inp.classList.contains('ps-title-in')) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (commitInput(inp)) refreshSheet();
      if (inp.name === 'pname') gridEl.querySelector('input[name=plocation]')?.focus();
      else focusCell(0, 0, true);
      return;
    }
    let dir = null;
    if (e.key === 'Enter') dir = e.shiftKey ? 'up' : 'down';
    else if (e.key === 'Tab') dir = e.shiftKey ? 'left' : 'right';
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.metaKey) dir = e.key === 'ArrowDown' ? 'down' : 'up';
    if (!dir) return;
    const td = inp.closest('td[data-i]');
    const target = navTarget(td, dir);
    if (!target && e.key === 'Tab') return; // Tab off the end leaves the sheet; change commits it
    e.preventDefault();
    hidePick();
    const go = target || { r: Number(td.dataset.r), col: Number(td.dataset.col) };
    if (commitInput(inp)) afterCommit(go);
    else focusCell(go.r, go.col, true);
  }

  gridEl.addEventListener('keydown', onSheetKey);
  // A tall (merged) cell is bigger than its one-line input: a tap anywhere in it edits it.
  gridEl.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    const inp = e.target.closest('td[data-i]')?.querySelector('input.ps-in');
    if (inp) inp.focus();
  });
  gridEl.addEventListener('focusin', (e) => {
    const inp = e.target;
    if (inp.matches && inp.matches('input.ps-in') && !inp.classList.contains('ps-title-in')) { pickTyped = false; showPick(inp); }
    else if (!pickEl.contains(inp)) hidePick();
  });
  gridEl.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.matches || !inp.matches('input.ps-in') || inp.classList.contains('ps-title-in')) return;
    pickSuppressed = '';
    pickTyped = true;
    showPick(inp);
  });
  gridEl.addEventListener('focusout', (e) => {
    if (!e.target.matches || !e.target.matches('input.ps-in')) return;
    setTimeout(() => { if (!pickInput || document.activeElement !== pickInput) hidePick(); }, 0);
  });
  // A tap elsewhere commits the cell that was being edited (change fires before focus moves).
  gridEl.addEventListener('change', (e) => {
    const inp = e.target;
    if (inp.matches && inp.matches('input.ps-in') && commitInput(inp)) afterCommit(null);
  });

  // --- Excel / Google Sheets ---

  function exportXlsx() {
    const pp = panelPrintSettings(store.settings());
    const co = store.settings().company || {};
    let bytes;
    try {
      bytes = PS.panelXlsx(panel, {
        layout: layoutFor(true),
        legColors: legFills(pp),
        highlight: (c) => highlightFor(c, pp),
        company: co,
        logo: dataUrlBytes(co.logo),
        contactLine: sheetSet().contactLine,
      });
    } catch (e) {
      ui.toast(`Couldn't build the spreadsheet: ${e.message}`, 'error', 4500);
      return;
    }
    ui.download(xlsxFileName(panel.name, 'Panel schedule'), new Blob([bytes], { type: XLSX_MIME }), XLSX_MIME);
  }

  function openGoogleHint() {
    const sheet = ui.openSheet({
      title: 'Open in Google Sheets',
      body: h('div', { class: 'stack ps-google' },
        h('p', null, 'Google Sheets opens the Excel file directly: the merged cells, colours, borders and one-page print setup come across.'),
        h('ol', null,
          h('li', null, 'Tap ', h('strong', null, 'Download .xlsx'), ' below.'),
          h('li', null, 'On a computer, go to drive.google.com, choose ', h('strong', null, 'New → File upload'), ' and pick the file. On an iPad or phone, open the Google Drive app, tap ', h('strong', null, '+ → Upload'), ' and pick it from Files.'),
          h('li', null, 'Open it, then choose ', h('strong', null, 'File → Save as Google Sheets'), ' to keep an editable copy.')),
        h('p', { class: 'muted small' }, 'If the logo doesn’t come through, add it with Insert → Image → Image over cells. A schedule filled in Excel or Sheets comes back into Fishtape with Import .xlsx on the panel list.')),
      actions: [
        ui.button('Close', { variant: 'ghost', onClick: () => sheet.close() }),
        ui.button('Download .xlsx', { variant: 'primary', icon: 'download', onClick: () => { exportXlsx(); sheet.close(); } }),
      ],
    });
  }

  function drawSummary() {
    ui.clear(summaryEl);
    const { sys, b, main, loadPct } = summary(panel);
    const cec = bookOf() === 'CEC-2024';
    const maxPhase = Math.max(1, ...Object.values(b.perPhase));
    const totalAmps = S.totalAmps(b.totalVA, panel.voltage);
    const contRef = cec ? 'Rule 8-104(6)' : 'NEC 210.20(A), 215.3';
    const warnings = [];
    if (main && b.maxAmps > 0.8 * main) warnings.push(`Heaviest phase is ${ui.fmtNum(loadPct, 0)}% of the ${main} A main: over 80% for continuous loads (${contRef}).`);
    if (b.imbalancePct > 10) warnings.push(`Phases are ${ui.fmtNum(b.imbalancePct, 1)}% out of balance. Move loads to the lightest phase.`);
    if (main && Number(panel.busAmps) && main > Number(panel.busAmps)) warnings.push(`Main ${main} A is larger than the ${panel.busAmps} A bus rating.`);
    const hot = (panel.circuits || []).filter((c) => c.amps && circuitAmps(c, panel.voltage) > 0.8 * c.amps);
    // Label tandems with their A/B so two halves of one space are told apart.
    if (hot.length) warnings.push(`${hot.length} breaker${hot.length > 1 ? 's are' : ' is'} loaded over 80% (${contRef}): ${hot.map((c) => `${c.slot}${halfOf(c) || ''}`).join(', ')}.`);
    if (!sys.neutral && (panel.circuits || []).some((c) => (Number(c.poles) || 1) < 2)) warnings.push('1-pole breakers on a system with no neutral: change them to 2- or 3-pole.');

    summaryEl.append(
      h('div', { class: 'card panel-phases' },
        h('div', { class: 'calc-label' }, `Phase loads · ${sys.label}`),
        Object.entries(b.perPhase).map(([p, va]) => h('div', { class: 'phase-row' },
          h('span', { class: ['slot-phase', 'ph-' + p] }, p),
          h('div', { class: 'progress grow' }, h('i', { class: 'ph-fill-' + p, style: { width: `${(va / maxPhase) * 100}%` } })),
          h('span', { class: 'num phase-val' }, `${ui.fmtNum(va)} VA · ${ui.fmtNum(b.amps[p], 1)} A`))),
        sys.neutral ? null : h('div', { class: 'calc-note muted' }, `No neutral: per-phase amps use ${ui.fmtNum(S.phaseVolts(panel.voltage), 0)} V (${sys.llVolts} V ÷ √3).`)),
      h('div', { class: 'panel-stats' },
        ui.stat({ label: 'Connected load', value: `${ui.fmtNum(b.totalVA / 1000, 1)} kVA`, hint: `${ui.fmtNum(totalAmps, 1)} A ${sys.three ? '3φ at ' + sys.llVolts + ' V' : 'at ' + sys.llVolts + ' V'}` }),
        ui.stat({ label: 'Imbalance', value: `${ui.fmtNum(b.imbalancePct, 1)}%`, tone: b.imbalancePct > 10 ? 'danger' : 'success', hint: 'Max deviation from average' }),
        h('div', { class: 'card stat' },
          h('span', { class: 'label' }, 'Load vs main'),
          h('span', { class: 'value' }, main ? `${ui.fmtNum(loadPct, 0)}%` : '—'),
          h('div', { class: 'progress' }, h('i', { style: { width: `${Math.min(100, loadPct)}%`, background: loadPct > 80 ? 'var(--danger)' : '' } })),
          h('span', { class: 'hint' }, main ? `${ui.fmtNum(b.maxAmps, 1)} A of ${main} A, heaviest phase` : 'Set the main size'))),
      progressCard(),
      breakerListCard(),
      labelCard(),
      main ? serviceCard({ sys, b, main, totalAmps, cec }) : null,
      colourLegendCard(),
      warnings.length
        ? h('div', { class: 'card panel-warn', role: 'status' }, warnings.map((w) => h('div', { class: 'row' }, ui.icon('alert', 16), h('span', null, w))))
        : h('div', { class: 'card panel-ok' }, ui.icon('check', 16), ' No load or balance warnings.'),
    );
  }

  /** Fill-as-you-go progress: a completion bar plus a count of each wiring status. */
  function progressCard() {
    const c = completion(panel);
    const counts = {};
    for (const s of PANEL_STATUSES) counts[s.key] = 0;
    for (const x of (panel.circuits || [])) if (x.status && counts[x.status] != null) counts[x.status] += 1;
    return h('div', { class: 'card panel-progress' },
      h('div', { class: 'calc-label row-between' }, h('span', null, 'Job progress'),
        h('span', { class: 'num' }, c.described ? `${c.pct}% done` : 'Not started')),
      h('div', { class: 'progress' }, h('i', { class: 'progress-done', style: { width: `${c.pct}%` } })),
      h('div', { class: 'muted small' }, `${c.done} of ${c.described} wired circuit${c.described === 1 ? '' : 's'} marked done`),
      c.tracked ? h('div', { class: 'status-counts' }, PANEL_STATUSES.filter((s) => counts[s.key]).map((s) =>
        h('span', { class: ['status-chip', 'st-' + s.key] }, `${s.label} ${counts[s.key]}`))) : null);
  }

  /** Physical breakers in the panel, one per device: a full breaker is one; a tandem space (its A/B
   *  halves) is one combined device; a quad (inner + two outers) is one device. Each carries the
   *  resolved part number. The material takeoff aggregates these. */
  function breakerDevices() {
    const circuits = panel.circuits || [];
    const occ = occupancy(circuits);
    const out = [];
    const done = new Set();
    for (const c of circuits) {
      const half = halfOf(c);
      if (!half) { out.push({ slot: c.slot, desc: c.description, part: partOf(c) }); continue; }
      const home = Number(c.slot);
      if (isQuadInner(c)) {
        if (done.has('q' + home)) continue;
        done.add('q' + home);
        out.push({ slot: home, desc: c.description || '240 V load', part: partOf(c), quad: true });
        continue;
      }
      const o = occ.get(home) || {};
      if (isQuadInner(o.A) || isQuadInner(o.B)) continue; // a quad's outer single: counted in the quad
      if (done.has('t' + home)) continue;
      done.add('t' + home);
      const desc = [o.A && o.A.description, o.B && o.B.description].filter(Boolean).join(' / ');
      out.push({ slot: home, desc: desc || 'Tandem', part: partOf(c), tandem: true });
    }
    return out;
  }

  /** Per-panel breaker list with part numbers — a minimal material takeoff. Part numbers are fine for
   *  the crew; costs stay on the material request (office only). Lets the office roll the breakers
   *  into material requests for the job. Shown only when the panel has a breaker family. */
  function breakerListCard() {
    if (!panel.breakerFamily) return null;
    const withPart = breakerDevices().filter((d) => d.part && d.part.number);
    if (!withPart.length) return null;
    const agg = new Map();
    for (const d of withPart) {
      const k = d.part.number;
      const e = agg.get(k) || { number: k, qty: 0, confident: true, note: d.part.note, descs: new Set() };
      e.qty += 1;
      if (!d.part.confident) { e.confident = false; e.note = d.part.note; }
      if (d.desc) e.descs.add(d.desc);
      agg.set(k, e);
    }
    const rows = [...agg.values()];
    const me = ctx.auth && ctx.auth.current ? ctx.auth.current() : {};
    const listText = () => rows.map((r) => `${r.qty} x ${r.number}${r.descs.size ? '  ' + [...r.descs].join(', ') : ''}`).join('\n');
    const addToRequests = async () => {
      if (!(await ui.confirmDialog(`Add ${rows.length} breaker line${rows.length === 1 ? '' : 's'} to material requests${panel.jobId ? '' : ' (no job)'}?`, { okLabel: 'Add', danger: false }))) return;
      for (const r of rows) {
        store.add('materialRequests', {
          jobId: panel.jobId || null, itemId: null,
          description: `${r.number} breaker${r.descs.size ? ' — ' + [...r.descs].join(', ') : ''}`,
          qty: r.qty, unit: 'ea', note: `Panel ${panel.name || ''}`.trim() + (r.confident ? '' : ' (verify part no.)'),
          urgent: false, employeeId: (me && me.id) || null, status: 'requested',
        });
      }
      ui.toast(`Added ${rows.length} breaker line${rows.length === 1 ? '' : 's'} to material requests`, 'success', 3200);
      ctx.nav('#/materials' + (panel.jobId ? '?jobId=' + panel.jobId : ''));
    };
    const copy = async () => { try { await navigator.clipboard.writeText(listText()); ui.toast('Copied', 'success'); } catch { ui.toast('Copying is blocked here', 'error'); } };
    return h('div', { class: 'card panel-breakers no-print' },
      h('div', { class: 'calc-label row-between' }, h('span', null, `Breaker list · ${panel.manufacturer || ''} ${panel.line || panel.breakerFamily}`.trim()),
        ui.button('Copy', { variant: 'ghost', size: 'sm', icon: 'copy', onClick: copy })),
      h('table', { class: 'calc-lines panel-breaker-table' }, h('tbody', null, rows.map((r) => h('tr', null,
        h('td', { class: 'num bk-qty' }, `${r.qty}×`),
        h('td', null, h('span', { class: ['bk-part', r.confident ? null : 'verify'] }, r.number),
          r.confident ? null : h('span', { class: 'bk-verify', title: r.note || 'Verify against the stamped breaker' }, 'verify'),
          r.descs.size ? h('span', { class: 'muted' }, ' · ' + [...r.descs].join(', ')) : null))))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }),
        ui.button('Add to material requests', { variant: 'ghost', size: 'sm', icon: 'truck', onClick: addToRequests })),
      h('p', { class: 'calc-note muted' }, 'Part numbers come from the panel line; quantities count physical breakers (a tandem or quad is one device). Verify flagged numbers against the stamped breaker. Costs are set by the office on the material request.'));
  }

  /** On-screen panel label / sticker: the QR, the panel identity and the progress, to print and
   *  stick inside the panel door so a scan a year later reopens this exact panel. */
  function labelCard() {
    const url = thisPanelUrl();
    const c = completion(panel);
    return h('div', { class: 'card panel-label-card' },
      h('div', { class: 'calc-label row-between' }, h('span', null, 'Panel label'),
        ui.button('Print label', { variant: 'ghost', size: 'sm', icon: 'printer', onClick: printLabel })),
      h('div', { class: 'label-body' },
        h('div', { class: 'label-qr' }, qrSvgNode(url, { label: `Open panel ${panel.name}` })),
        h('div', { class: 'label-info' },
          h('div', { class: 'label-name' }, panel.name || 'Panel'),
          panel.location ? h('div', { class: 'label-loc' }, panel.location) : null,
          h('div', { class: 'muted small' }, serviceText()),
          h('div', { class: 'label-prog small' }, c.described ? `${c.pct}% wired` : 'Not started'),
          h('div', { class: 'muted tiny label-url' }, url))),
      h('p', { class: 'calc-note muted' }, 'Scan to open this panel on any device to view, update or reprint. Generated offline.'));
  }

  /** Service / feeder card: loading against the main, and conductors and bonding sized for it. */
  function serviceCard({ sys, b, main, totalAmps, cec }) {
    const rows = [];
    const add = (label, value, ref) => rows.push(h('tr', null, h('td', null, label, ref ? h('span', { class: 'muted' }, ` · ${ref}`) : null), h('td', { class: 'right num' }, value)));
    add('Connected load current', `${ui.fmtNum(totalAmps, 1)} A`, sys.three ? 'I = VA ÷ (√3 × V)' : 'I = VA ÷ V');
    add('Continuous-load limit (80% rated main)', `${ui.fmtNum(0.8 * main, 0)} A`, cec ? 'Rule 8-104(6)' : 'NEC 215.3');
    if (cec) {
      const term = CEC.terminationTemp({ amps: main });
      const cu = CEC.minConductorForAmps(main, 'cu', term);
      const al = CEC.minConductorForAmps(main, 'al', term);
      add(`Conductors for ${main} A at ${term} °C`, `${cu ? CEC.sizeLabel(cu) + ' Cu' : '—'} / ${al ? CEC.sizeLabel(al) + ' Al' : '—'}`, `Tables 2, 4; Rule 4-006`);
      const bond = CEC.bondingConductor(main);
      if (bond) add('Bonding conductor', `${CEC.sizeLabel(bond.cu)} Cu / ${CEC.sizeLabel(bond.al)} Al`, 'Table 16');
    } else {
      const temp = main <= 100 ? 60 : 75;
      const cu = E.SIZES.find((sz) => (E.ampacity(sz, 'cu', temp) || 0) >= main);
      const al = E.SIZES.find((sz) => (E.ampacity(sz, 'al', temp) || 0) >= main);
      add(`Conductors for ${main} A at ${temp} °C`, `${cu ? E.sizeLabel(cu) + ' Cu' : '—'} / ${al ? E.sizeLabel(al) + ' Al' : '—'}`, 'NEC Table 310.16, 110.14(C)');
    }
    return h('div', { class: 'card panel-service' },
      h('div', { class: 'calc-label' }, `Service / feeder · ${cec ? 'CEC 2024' : 'NEC 2023'}`),
      h('table', { class: 'calc-lines' }, h('tbody', null, rows)),
      h('p', { class: 'calc-note muted' }, 'Connected load, not a demand calculation. Conductors sized to the main rating in raceway or cable, 30 °C, three or fewer current-carrying conductors. ',
        cec ? h('a', { href: '#/calcs/load' }, 'Dwelling service (Rule 8-200)') : h('a', { href: '#/calcs/load' }, 'Dwelling load calc')));
  }

  /** Wire-colour legend: phase colours (convention) plus the mandated neutral and bond, with the disclaimer. */
  function colourLegendCard() {
    const colours = coloursNow();
    const swatch = (col) => h('span', { class: 'wire-swatch lg', style: { background: col.hex }, title: col.name });
    const row = (label, col, tag) => h('div', { class: 'legend-row' }, swatch(col), h('span', { class: 'legend-name' }, label, ' — ', col.name),
      h('span', { class: ['legend-tag', col.mandated ? 'mand' : 'conv'] }, col.mandated ? `Mandated${col.ref ? ' · ' + col.ref : ''}` : 'Convention'));
    return h('div', { class: 'card panel-colours' },
      h('div', { class: 'calc-label row-between' }, h('span', null, `Wire colours · ${colours.book === 'NEC-2023' ? 'NEC 2023' : 'CEC 2024'}`),
        ui.button('Edit colours', { variant: 'ghost', size: 'sm', icon: 'palette', onClick: () => openColourEditor() })),
      Object.entries(colours.phases).map(([p, col]) => row(`Phase ${p}`, col)),
      row('Neutral', colours.neutral),
      row('Bond / ground', colours.bond),
      h('p', { class: 'calc-note muted' }, S.COLOUR_LEGEND_NOTE));
  }

  /** Edit this company's phase/neutral/bond colours for the current system; saved in settings.panelColours. */
  function openColourEditor() {
    const book = bookOf();
    const colours = coloursNow();
    const sys = S.systemOf(panel.voltage);
    const hexOf = (c) => (/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#999999');
    const fields = [
      ...sys.phases.map((p) => ({ label: `Phase ${p}`, name: 'ph_' + p, type: 'color', value: hexOf(colours.phases[p]) })),
      { label: 'Neutral (mandated white/grey)', name: 'neutral', type: 'color', value: hexOf(colours.neutral) },
      { label: 'Bond / ground (mandated green)', name: 'bond', type: 'color', value: hexOf(colours.bond) },
    ];
    const presetBtn = (key) => ui.button(S.COLOUR_PRESETS[key].label, { variant: 'ghost', size: 'sm', onClick: () => {
      const form = sheet.el.querySelector('form');
      for (const p of sys.phases) { const el = form.querySelector(`[name=ph_${p}]`); if (el && S.COLOUR_PRESETS[key][p]) el.value = S.COLOUR_PRESETS[key][p]; }
    } });
    const sheet = ui.formSheet({
      title: `Edit colours · ${sys.label}`,
      fields,
      submitLabel: 'Save colours',
      extra: h('div', { class: 'tpl-presets' }, h('span', { class: 'muted small' }, 'Presets:'),
        presetBtn('rbb'), sys.phases.length > 2 ? presetBtn('boy') : null, presetBtn('brb')),
      danger: { label: 'Reset to code default', onClick: () => {
        const s = store.settings();
        const pc = { ...(s.panelColours || {}) };
        const bk = { ...(pc[book] || {}) };
        delete bk[panel.voltage];
        pc[book] = bk;
        store.saveSettings({ panelColours: pc });
        redraw();
      } },
      onSubmit: (v) => {
        const s = store.settings();
        const pc = { ...(s.panelColours || {}) };
        const bk = { ...(pc[book] || {}) };
        const sysOv = {};
        for (const p of sys.phases) sysOv[p] = v['ph_' + p];
        bk[panel.voltage] = sysOv;
        if (v.neutral) bk.neutral = v.neutral;
        if (v.bond) bk.bond = v.bond;
        pc[book] = bk;
        store.saveSettings({ panelColours: pc });
        redraw();
      },
    });
    return sheet;
  }

  /** The service line shown on the directory header. */
  function fullServiceLine(job) {
    const mainTxt = panel.mainType === 'MLO' ? `MLO${panel.mainAmps ? ' · ' + panel.mainAmps + ' A feed' : ''}` : `Main ${panel.mainAmps} A`;
    return `${sysLabel(panel.voltage)} · ${mainTxt} · Bus ${panel.busAmps} A${panel.feedThrough ? ' · feed-through' : ''}${job ? ` · ${job.number} ${job.title}` : ''}`;
  }

  // The printed schedule is the sheet itself, in the template's layout: titleblock, the
  // DESCRIPTION | CCT. NO | AMP || AMP | CCT. NO | DESCRIPTION grid (empty spaces split A/B like the
  // blank template), and the company's logo block at the bottom. Fitted to one portrait page: the
  // body rows share the height left after the titleblock and logo block.
  function drawPrint() {
    ui.clear(printEl);
    const pp = panelPrintSettings(store.settings());
    const layout = layoutFor(true);
    const rowIn = Math.min(0.21, 7.3 / Math.max(1, layout.rows));
    printEl.className = 'print-only panel-print ps-print';
    printEl.style.setProperty('--ps-row', rowIn.toFixed(3) + 'in');
    printEl.style.setProperty('--ps-fs', Math.max(5.5, Math.min(9.5, rowIn * 72 * 0.6)).toFixed(1) + 'pt');
    const colours = coloursNow();
    const legendChip = (label, col) => h('span', { class: 'print-legend-chip' }, h('span', { class: 'wire-swatch', style: { background: col.hex } }), `${label}: ${col.name}`);
    // .filter(Boolean): native Element.append() turns null into a literal "null" text node.
    printEl.append(...[
      sheetTable(layout, { editable: false, qr: pp.showQr }),
      // The key: CCT. NO fills are legs (not wire colours), then the wire colours themselves.
      pp.showLegend ? h('div', { class: 'print-legend' },
        pp.phaseBandsOn ? Object.keys(colours.phases).map((p) => {
          const sw = h('span', { class: 'ps-legend-leg' });
          sw.style.backgroundColor = legFills(pp)[p];
          return h('span', { class: 'print-legend-chip' }, sw, `Leg ${p}`);
        }) : null,
        Object.entries(colours.phases).map(([p, col]) => legendChip(`Wire ${p}`, col)),
        legendChip('N', colours.neutral), legendChip('Bond', colours.bond)) : null,
    ].filter(Boolean));
  }

  // The standalone panel label / sticker: the QR big enough to scan from arm's length, the panel
  // identity, the progress, and the company footer. Printed on its own via printLabel().
  function drawLabel() {
    ui.clear(labelPrintEl);
    const job = jobs.find((j) => j.id === panel.jobId);
    labelPrintEl.append(
      h('div', { class: 'pl-card' },
        h('div', { class: 'pl-qr' }, qrSvgNode(thisPanelUrl(), { label: `Open panel ${panel.name}` })),
        h('div', { class: 'pl-info' },
          h('h1', null, panel.name),
          panel.location ? h('div', { class: 'pl-loc' }, panel.location) : null,
          h('div', { class: 'pl-service' }, fullServiceLine(job)),
          h('div', { class: 'pl-hint' }, 'Scan to open this panel to view, update or reprint.'),
          h('div', { class: 'pl-url' }, thisPanelUrl()))));
  }

  function redraw() { drawSheet(); drawSummary(); drawPrint(); drawLabel(); syncHead(); }

  const del = async () => {
    if (!(await ui.confirmDialog(`Delete ${panel.name} and its ${panel.circuits?.length || 0} circuits?`, { okLabel: 'Delete' }))) return;
    store.remove('panels', panel.id);
    ctx.nav('#/panels' + (panel.jobId ? '?jobId=' + panel.jobId : ''));
  };

  root.append(ui.page(
    {
      title: panel.name,
      subtitle: 'Fill it in like the sheet: tap a cell and type. Phases follow the bus.',
      actions: [
        ui.button('', { variant: 'ghost', icon: 'chevron-left', title: 'All panels', href: '#/panels' + (panel.jobId ? '?jobId=' + panel.jobId : '') }),
        !S.systemOf(panel.voltage).three ? ui.button('Residential essentials', { variant: 'ghost', icon: 'home', onClick: fillResidential }) : null,
        ui.button('Print options', { variant: 'ghost', icon: 'sliders', onClick: openPrintOptions }),
        ui.button('Panel label', { variant: 'ghost', icon: 'qr', onClick: printLabel }),
        ui.button('Print', { icon: 'printer', title: 'Print the schedule (or save it as a PDF)', onClick: () => window.print() }),
        ui.button('', { variant: 'ghost danger', icon: 'trash', title: 'Delete panel', onClick: del }),
      ],
    },
    gridEl, head, summaryEl, printEl, labelPrintEl,
  ));
  root.lastElementChild.classList.add('panel-page');
  redraw();
}

export default {
  id: 'panels',
  title: 'Panel schedules',
  icon: 'panel',
  group: 'field',
  perm: 'panels',
  render(root, ctx) {
    ui = ctx.ui; h = ui.h; store = ctx.store;
    if (ctx.params[0]) editorView(root, ctx, ctx.params[0]);
    else listView(root, ctx);
  },
};
