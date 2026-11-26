// The panel schedule as a spreadsheet: one layout model drives the on-screen grid, the printed
// schedule and the .xlsx export, and the importer reads the same template back into a panel.
//
// Layout (TG Electric's sheet, the template the field crews already use):
//   PANEL NAME     | <name>
//   PANEL LOCATION | <location>
//   200A - 120/240V - 1 PH                          (full width)
//   DESCRIPTION | CCT. NO | AMP || AMP | CCT. NO | DESCRIPTION
// Each breaker space is two sheet rows (its A and B halves). A full-size breaker merges the two;
// a tandem shows them split with a dotted line between; a multi-pole breaker merges its AMP and
// DESCRIPTION cells across all its spaces while each space keeps its own CCT. NO cell. CCT. NO
// cells are filled by leg/phase (A/B on 120/240 1φ, A/B/C on 3φ). By default even circuits are on
// the left, odd on the right, and circuit 1/2 is at the BOTTOM (the sheet counts upward); both are
// company options (settings.panelSheet).
//
// The data model is the panel record as it always was (circuits with slot / half / poles); this
// file only lays it out. Pure: no DOM.
import * as S from './cec/systems.js';
import { buildXlsx, colWidthPx, imageInfo } from './xlsx.js';

// ---------------------------------------------------------------------------
// Occupancy (moved here from modules/panels.js, which re-exports them unchanged)
// ---------------------------------------------------------------------------

export const SLOT_COUNTS = [12, 16, 20, 24, 30, 32, 40, 42, 54, 60, 66, 72, 84];

/** The half of a space a circuit sits in: 'A' or 'B' for a tandem, else null (full space). */
export const halfOf = (c) => (c && (c.half === 'A' || c.half === 'B') ? c.half : null);

/**
 * A quad (space-saver / "Eaton quad") inner 2-pole: a half-space circuit that carries 2 poles.
 * It sits in the 'B' half of its own space and reaches into the 'A' half of the next space on the
 * same side (slot + 2), so it crosses both legs while the two outer halves stay free for singles.
 */
export const isQuadInner = (c) => halfOf(c) === 'B' && (Number(c && c.poles) || 1) === 2;

/** Last slot a circuit reaches: a quad inner reaches slot + 2, a half only its own space, a full
 *  breaker 2 × (poles − 1) more. */
export const spanTo = (c) => (halfOf(c) ? (isQuadInner(c) ? Number(c.slot) + 2 : Number(c.slot)) : Number(c.slot) + 2 * ((Number(c.poles) || 1) - 1));

/** Number of slots: stored value, else the smallest standard count that fits the circuits. */
export function slotCount(panel) {
  if (panel.slots) return panel.slots;
  const used = Math.max(0, ...(panel.circuits || []).map(spanTo));
  return SLOT_COUNTS.find((s) => s >= Math.max(used, 24)) || 84;
}

/**
 * Occupancy of every space a circuit touches. Returns a Map slot -> { full, start, A, B }:
 * `full` is a whole-space breaker on the slot (null if none), `start` is true on its first slot,
 * and `A`/`B` are the half-space circuits in the two halves (null if empty).
 */
export function occupancy(circuits) {
  const map = new Map();
  const at = (slot) => {
    let o = map.get(slot);
    if (!o) { o = { full: null, start: false, A: null, B: null }; map.set(slot, o); }
    return o;
  };
  for (const c of circuits) {
    const half = halfOf(c);
    if (half) {
      at(Number(c.slot))[half] = c;
      if (isQuadInner(c)) at(Number(c.slot) + 2).A = c;
      continue;
    }
    const poles = Number(c.poles) || 1;
    for (let k = 0; k < poles; k++) {
      const o = at(Number(c.slot) + 2 * k);
      o.full = c;
      if (k === 0) o.start = true;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Settings and text
// ---------------------------------------------------------------------------

/** Company sheet layout (settings.panelSheet). Defaults follow the TG template. */
export const SHEET_DEFAULTS = { evenLeft: true, bottomUp: true, contactLine: true };

export function sheetSettings(settings) {
  const ps = (settings && settings.panelSheet && typeof settings.panelSheet === 'object') ? settings.panelSheet : {};
  return {
    evenLeft: ps.evenLeft !== false,
    bottomUp: ps.bottomUp !== false,
    contactLine: ps.contactLine !== false,
  };
}

/** The sheet's fixed colours: title/header rows and the AMP columns are light grey, like the template. */
export const SHEET_COLOURS = { title: '#d9d9d9', amp: '#d9d9d9', desc: '#ffffff', border: '#000000', text: '#000000' };

/** Leg fills for the CCT. NO cells (company-overridable through settings.panelPrint.phaseBands). */
export const SHEET_LEG_DEFAULTS = { A: '#e06666', B: '#999999', C: '#6fa8dc' };

/** Terse type tags written after the amps: "15 AFI", "20 GFI", "15 DF". */
export const AMP_TAGS = { afci: 'AFI', gfci: 'GFI', dual: 'DF' };

/** The AMP cell text: "15", "15 AFI", "40". A multi-pole's merged cell already shows its poles. */
export function sheetAmpText(c) {
  if (!c || c.amps == null || c.amps === '' || !Number(c.amps)) return '';
  const tag = AMP_TAGS[c.breakerType];
  return `${Number(c.amps)}${tag ? ' ' + tag : ''}`;
}

/**
 * Read what someone typed in an AMP cell: "15", "15 AFI", "15afci", "20 GFI", "20 DF", "40 2P",
 * "30/2", "60A HACR". Returns { amps, breakerType, poles } with null for anything not given.
 * breakerType is 'afci' | 'gfci' | 'dual' | 'hacr' | null.
 */
export function parseAmpText(text) {
  const t = String(text ?? '').toUpperCase().replace(/(\d)([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const out = { amps: null, breakerType: null, poles: null };
  if (!t) return out;
  const num = /\d{1,4}/.exec(t);
  if (num) out.amps = Number(num[0]) || null;
  const pm = /\b([23]) ?P(?:OLE)?\b/.exec(t) || /\/ ?([23])\b/.exec(t);
  if (pm) out.poles = Number(pm[1]);
  if (/\bDF\b|\bDUAL\b|\bAFC?I ?\/ ?GFC?I\b|\bGFC?I ?\/ ?AFC?I\b/.test(t)) out.breakerType = 'dual';
  else if (/\bC?AFC?I\b|\bARC\b/.test(t)) out.breakerType = 'afci';
  else if (/\bGFC?I\b/.test(t)) out.breakerType = 'gfci';
  else if (/\bHACR\b/.test(t)) out.breakerType = 'hacr';
  return out;
}

/** The full-width service line: "200A - 120/240V - 1 PH" (MLO and a no-neutral 3-wire noted). */
export function sheetServiceLine(panel) {
  const sys = S.systemOf(panel && panel.voltage);
  const volts = sys.lnVolts ? `${sys.lnVolts}/${sys.llVolts}V` : `${sys.llVolts}V`;
  const parts = [];
  const main = Number(panel && panel.mainAmps) || 0;
  if (main) parts.push(`${main}A${panel.mainType === 'MLO' ? ' MLO' : ''}`);
  else if (panel && panel.mainType === 'MLO') parts.push('MLO');
  parts.push(volts);
  parts.push(`${sys.three ? 3 : 1} PH${sys.neutral ? '' : ' 3W'}`);
  return parts.join(' - ');
}

/** Read a service line back: { mainAmps, voltage, mainType } (null for what isn't there). */
export function parseServiceLine(text) {
  const t = String(text || '').toUpperCase();
  const out = { mainAmps: null, voltage: null, mainType: /\bMLO\b/.test(t) ? 'MLO' : null };
  const a = /(\d{2,4})\s*A(?:MP|MPS)?\b/.exec(t);
  if (a) out.mainAmps = Number(a[1]);
  const ph = /([13])\s*(?:PH\b|PHASE|Ø|Φ)/.exec(t);
  const three = ph ? ph[1] === '3' : null;
  const pair = /(\d{3})\s*\/\s*(\d{3})\s*Y?\s*V?/.exec(t);
  const one = /(\d{3})\s*V\b/.exec(t);
  const v = pair ? [Number(pair[1]), Number(pair[2])].sort((x, y) => x - y) : (one ? [Number(one[1])] : null);
  if (v) {
    const k = v.join('/');
    if (k === '120/240') out.voltage = '120/240 1ph';
    else if (k === '120/208') out.voltage = '208/120 3ph';
    else if (k === '347/600') out.voltage = '347/600 3ph';
    else if (k === '277/480') out.voltage = '480/277 3ph';
    else if (k === '600' && three !== false) out.voltage = '600 3ph 3w';
    else if (k === '240') out.voltage = '120/240 1ph';
    else if (k === '208') out.voltage = '208/120 3ph';
  }
  return out;
}

/** Mix a hex colour toward white (amount 0..1 of white), for a pale highlight fill. */
export function tint(hex, amount = 0.75) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const mix = (v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0');
  return '#' + mix((n >> 16) & 255) + mix((n >> 8) & 255) + mix(n & 255);
}

/** Readable text (#000000 / #ffffff) on a fill: dark text unless the fill is genuinely dark. */
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const L = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return L < 0.45 ? '#ffffff' : '#000000';
}

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

/** Column index of each cell kind per side: L = DESCRIPTION, CCT, AMP; R mirrors it. */
export const SHEET_COLS = { L: { desc: 0, cct: 1, amp: 2 }, R: { amp: 3, cct: 4, desc: 5 } };
export const SHEET_HEADERS = ['DESCRIPTION', 'CCT. NO', 'AMP', 'AMP', 'CCT. NO', 'DESCRIPTION'];

/**
 * Lay a panel out as sheet cells.
 * opts: { evenLeft, bottomUp, splitEmpty (draw an empty space as A/B halves, like the blank
 *        template), tandems (whether halves are possible at all; false never splits an empty space) }
 * Returns { rows, slots, cells, cover } where
 *   rows   body rows (2 per space position: slots/2 positions × 2),
 *   cells  [{ side 'L'|'R', kind 'desc'|'cct'|'amp', col 0..5, r, span, slot, half, leg,
 *             state 'full'|'half'|'quad'|'empty'|'emptyHalf', circuit, text, poles }],
 *   cover  cover[r][col] = index into cells of the cell covering that grid position.
 * A cell edge that falls inside a space (between its A and B rows) is a dotted separator: test
 * with `(r % 2 === 1)` for the top edge and `((r + span) % 2 === 1)` for the bottom edge.
 */
export function sheetLayout(panel, opts = {}) {
  const evenLeft = opts.evenLeft !== false;
  const bottomUp = opts.bottomUp !== false;
  const splitEmpty = !!opts.splitEmpty && opts.tandems !== false;
  const total = slotCount(panel);
  const positions = Math.ceil(total / 2);
  const rows = positions * 2;
  const occ = occupancy(panel.circuits || []);
  const sideOf = (slot) => ((slot % 2 === 0) === evenLeft ? 'L' : 'R');
  const posTop = (slot) => { const p = Math.ceil(slot / 2); return bottomUp ? (positions - p) * 2 : (p - 1) * 2; };
  const halfRow = (slot, half) => posTop(slot) + ((half === 'A') === bottomUp ? 1 : 0);
  const cells = [];
  const push = (side, kind, r, span, extra) => cells.push({ side, kind, col: SHEET_COLS[side][kind], r, span, ...extra });
  const textOf = (kind, c) => (c ? (kind === 'desc' ? String(c.description || '') : sheetAmpText(c)) : '');

  for (let slot = 1; slot <= total; slot++) {
    const side = sideOf(slot);
    const leg = S.slotPhase(slot, panel.voltage);
    const o = occ.get(slot);
    const top = posTop(slot);
    if (o && o.full) {
      const c = o.full;
      push(side, 'cct', top, 2, { slot, half: null, leg, state: 'full', circuit: c, text: String(slot) });
      if (o.start) {
        const poles = Number(c.poles) || 1;
        const tops = [];
        for (let k = 0; k < poles; k++) if (slot + 2 * k <= total) tops.push(posTop(slot + 2 * k));
        const r1 = Math.min(...tops);
        const span = Math.max(...tops) + 2 - r1;
        for (const kind of ['desc', 'amp']) push(side, kind, r1, span, { slot, half: null, leg, state: 'full', circuit: c, poles, text: textOf(kind, c) });
      }
      continue;
    }
    const split = !!(o && (o.A || o.B));
    if (!split && !splitEmpty) {
      push(side, 'cct', top, 2, { slot, half: null, leg, state: 'empty', circuit: null, text: String(slot) });
      for (const kind of ['desc', 'amp']) push(side, kind, top, 2, { slot, half: null, leg, state: 'empty', circuit: null, text: '' });
      continue;
    }
    for (const half of ['A', 'B']) {
      const r = halfRow(slot, half);
      const x = o ? o[half] : null;
      const reached = x && isQuadInner(x) && Number(x.slot) !== slot;
      push(side, 'cct', r, 1, { slot, half, leg, state: x ? (isQuadInner(x) ? 'quad' : 'half') : 'emptyHalf', circuit: x, text: `${slot}${half}` });
      if (reached) continue; // a quad inner's reach is covered by its home half's merged cells
      if (!x) {
        for (const kind of ['desc', 'amp']) push(side, kind, r, 1, { slot, half, leg, state: 'emptyHalf', circuit: null, text: '' });
        continue;
      }
      if (isQuadInner(x)) {
        const r2 = slot + 2 <= total ? halfRow(slot + 2, 'A') : r;
        for (const kind of ['desc', 'amp']) push(side, kind, Math.min(r, r2), r2 === r ? 1 : 2, { slot, half, leg, state: 'quad', circuit: x, poles: 2, text: textOf(kind, x) });
        continue;
      }
      for (const kind of ['desc', 'amp']) push(side, kind, r, 1, { slot, half, leg, state: 'half', circuit: x, text: textOf(kind, x) });
    }
  }
  const cover = Array.from({ length: rows }, () => new Array(6).fill(-1));
  cells.forEach((cell, i) => {
    for (let r = cell.r; r < cell.r + cell.span && r < rows; r++) if (r >= 0) cover[r][cell.col] = i;
  });
  return { rows, slots: total, cells, cover, evenLeft, bottomUp };
}

// ---------------------------------------------------------------------------
// .xlsx export
// ---------------------------------------------------------------------------

/** Column widths (Excel characters): DESCRIPTION, CCT. NO, AMP | AMP, CCT. NO, DESCRIPTION. */
export const SHEET_COL_WIDTHS = [26, 8.5, 7.5, 7.5, 8.5, 26];

/**
 * The buildXlsx() spec for a panel. Pure; the caller supplies what lives in settings:
 *   layout      sheetLayout(panel, { ..., splitEmpty: true })
 *   legColors   { A, B, C } CCT. NO fills
 *   highlight   (circuit) -> '#rrggbb' | null   (smoke/alarm and chosen row highlights)
 *   company     { name, phone, website, email }
 *   logo        Uint8Array of a PNG/JPEG, or null
 *   contactLine show the phone · website · email line under the logo
 */
export function panelWorkbookSpec(panel, { layout, legColors = SHEET_LEG_DEFAULTS, highlight = () => null, company = {}, logo = null, contactLine = true } = {}) {
  const L = layout || sheetLayout(panel, { splitEmpty: true });
  const font = { name: 'Arial', size: 10 };
  const thin = 'thin';
  const box = (extra = {}) => ({ top: thin, right: thin, bottom: thin, left: thin, ...extra });
  const centre = { h: 'center', v: 'center' };
  const rows = [];
  const merges = [];
  const set = (r, c, v, s) => { if (!rows[r]) rows[r] = { cells: [] }; rows[r].cells[c] = { v, s }; };
  const rowH = (r, h) => { if (!rows[r]) rows[r] = { cells: [] }; rows[r].height = h; };

  // Titleblock
  const titleS = { fill: SHEET_COLOURS.title, border: box(), align: { h: 'left', v: 'center' }, font };
  const titleValS = { ...titleS, font: { ...font, bold: true } };
  set(0, 0, 'PANEL NAME', titleS); set(0, 1, String(panel.name || ''), titleValS); merges.push({ r1: 0, c1: 1, r2: 0, c2: 5 });
  set(1, 0, 'PANEL LOCATION', titleS); set(1, 1, String(panel.location || ''), titleValS); merges.push({ r1: 1, c1: 1, r2: 1, c2: 5 });
  set(2, 0, sheetServiceLine(panel), { ...titleS, align: centre }); merges.push({ r1: 2, c1: 0, r2: 2, c2: 5 });
  SHEET_HEADERS.forEach((t, c) => set(3, c, t, {
    fill: SHEET_COLOURS.title, font, align: c === 0 || c === 5 ? { h: 'left', v: 'center' } : centre,
    border: box(c === 2 ? { right: 'double' } : c === 3 ? { left: 'double' } : {}),
  }));
  for (let r = 0; r < 4; r++) rowH(r, 15);

  // Body
  const B0 = 4;
  for (let r = 0; r < L.rows; r++) rowH(B0 + r, 13.5);
  for (const cell of L.cells) {
    const top = cell.r % 2 === 1 ? 'dotted' : thin;
    const bottom = (cell.r + cell.span) % 2 === 1 ? 'dotted' : thin;
    const border = { top, bottom, left: thin, right: thin };
    if (cell.col === 2) border.right = 'double';
    if (cell.col === 3) border.left = 'double';
    let s;
    let v = cell.text || null;
    if (cell.kind === 'cct') {
      const fill = legColors[cell.leg] || SHEET_LEG_DEFAULTS[cell.leg] || '#ffffff';
      s = { fill, border, align: centre, font: { ...font, color: inkOn(fill) } };
    } else if (cell.kind === 'amp') {
      s = { fill: SHEET_COLOURS.amp, border, align: centre, font };
      if (v && /^\d+$/.test(v)) v = Number(v);
    } else {
      const hl = cell.circuit ? highlight(cell.circuit) : null;
      s = { border, align: { h: 'left', v: 'center', wrap: cell.span > 1 }, font };
      if (hl) s.fill = tint(hl, 0.75);
    }
    set(B0 + cell.r, cell.col, v, s);
    if (cell.span > 1) merges.push({ r1: B0 + cell.r, c1: cell.col, r2: B0 + cell.r + cell.span - 1, c2: cell.col });
  }

  // Logo block: the company's own logo (or its name), then a contact line.
  const LR = B0 + L.rows;
  const info = logo ? imageInfo(logo) : null;
  const contact = [company.phone, company.website, company.email].map((x) => String(x || '').trim()).filter(Boolean).join('   ·   ');
  const blockPt = 78;
  set(LR, 0, info ? null : (String(company.name || '').trim() || null), { border: box(), align: centre, font: { ...font, size: 18, bold: true } });
  merges.push({ r1: LR, c1: 0, r2: LR, c2: 5 });
  rowH(LR, blockPt);
  let last = LR;
  if (contactLine && contact) {
    last = LR + 1;
    set(last, 0, contact, { border: box(), align: centre, font: { ...font, size: 9 } });
    merges.push({ r1: last, c1: 0, r2: last, c2: 5 });
    rowH(last, 15);
  }
  for (let r = 0; r <= last; r++) if (!rows[r]) rows[r] = { cells: [] };

  const images = [];
  if (info) {
    const totalPx = SHEET_COL_WIDTHS.reduce((s, w) => s + colWidthPx(w), 0);
    const blockPx = blockPt / 0.75;
    const maxH = blockPx - 10;
    const maxW = totalPx * 0.7;
    const scale = Math.min(maxH / info.height, maxW / info.width);
    const w = Math.max(1, Math.round(info.width * scale));
    const hgt = Math.max(1, Math.round(info.height * scale));
    let x = Math.round((totalPx - w) / 2);
    let col = 0;
    while (col < SHEET_COL_WIDTHS.length - 1 && x >= colWidthPx(SHEET_COL_WIDTHS[col])) { x -= colWidthPx(SHEET_COL_WIDTHS[col]); col += 1; }
    images.push({ bytes: logo, at: { col, xPx: x, row: LR, yPx: Math.round((blockPx - hgt) / 2) }, widthPx: w, heightPx: hgt, name: 'Logo' });
  }

  return {
    font,
    sheets: [{
      name: String(panel.name || 'Panel').slice(0, 31),
      cols: SHEET_COL_WIDTHS,
      rows,
      merges,
      showGrid: false,
      print: { orientation: 'portrait', paper: 'letter', fitToPage: true, centerH: true, margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
      images,
    }],
  };
}

/** The finished .xlsx bytes for a panel (see panelWorkbookSpec for opts). */
export function panelXlsx(panel, opts = {}) {
  return buildXlsx(panelWorkbookSpec(panel, opts));
}

// ---------------------------------------------------------------------------
// .xlsx import: a filled sheet in this template back into a panel
// ---------------------------------------------------------------------------

/**
 * Turn a read sheet ({ cells: Map('r:c' -> text), merges }) in this template into panel fields:
 *   { name, location, voltage, mainAmps, mainType, slots, circuits, skipped }
 * Either side order and either numbering direction reads, because every circuit is found by its
 * CCT. NO cell. A DESCRIPTION/AMP cell merged across several spaces becomes one multi-pole breaker;
 * one merged across a B half and the next space's A half is a quad's inner 2-pole. Throws when no
 * DESCRIPTION / CCT. NO header row is found.
 */
export function panelFromSheet(grid) {
  const cells = grid.cells instanceof Map ? grid.cells : new Map(Object.entries(grid.cells || {}));
  const merges = grid.merges || [];
  const mergeAt = new Map();
  for (const m of merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) mergeAt.set(`${r}:${c}`, m);
  const anchor = (r, c) => { const m = mergeAt.get(`${r}:${c}`); return m ? { r: m.r1, c: m.c1, m } : { r, c, m: null }; };
  const raw = (r, c) => String(cells.get(`${r}:${c}`) ?? '').trim();
  const val = (r, c) => { const a = anchor(r, c); return raw(a.r, a.c); };
  let maxRow = -1;
  let maxCol = -1;
  for (const k of cells.keys()) { const [r, c] = k.split(':').map(Number); maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, c); }
  for (const m of merges) { maxRow = Math.max(maxRow, m.r2); maxCol = Math.max(maxCol, m.c2); }

  // Header row: the first row with a CCT column and a DESCRIPTION column.
  let hr = -1;
  let cctCols = [];
  for (let r = 0; r <= maxRow && hr < 0; r++) {
    const cc = [];
    let desc = false;
    for (let c = 0; c <= maxCol; c++) {
      const t = raw(r, c).toUpperCase();
      if (/^(CCT|CKT|CIRCUIT)\b/.test(t)) cc.push(c);
      if (/^DESC/.test(t)) desc = true;
    }
    if (cc.length && desc) { hr = r; cctCols = cc.slice(0, 2); }
  }
  if (hr < 0) throw new Error('No DESCRIPTION / CCT. NO header row found. Use the panel schedule template.');
  const head = (c) => raw(hr, c).toUpperCase();
  const nearest = (from, dir, test, stop) => {
    for (let c = from + dir; c >= 0 && c <= maxCol && c !== stop; c += dir) if (test(head(c))) return c;
    return -1;
  };
  const sides = cctCols.map((cct, i) => {
    const other = cctCols[1 - i];
    const outward = other == null ? (nearest(cct, -1, (t) => /^DESC/.test(t)) >= 0 ? -1 : 1) : (other > cct ? -1 : 1);
    const desc = nearest(cct, outward, (t) => /^DESC/.test(t));
    const amp = nearest(cct, -outward, (t) => /^AMP|^BKR|^BREAKER|^SIZE/.test(t), other);
    return { cct, desc, amp };
  });

  // Title rows above the header.
  let name = '';
  let location = '';
  let service = '';
  const rightOf = (r, c) => {
    const a = anchor(r, c);
    const start = a.m ? a.m.c2 + 1 : c + 1;
    for (let k = start; k <= maxCol; k++) { const v = val(r, k); if (v) return v; }
    return '';
  };
  for (let r = 0; r < hr; r++) {
    for (let c = 0; c <= maxCol; c++) {
      const t = raw(r, c);
      if (!t) continue;
      if (/^PANEL\s*NAME/i.test(t)) name = name || rightOf(r, c);
      else if (/^PANEL\s*LOC/i.test(t)) location = location || rightOf(r, c);
      else if (/\d\s*V\b|\d\s*\/\s*\d{3}/i.test(t) && /PH|Ø|Φ|\dA\b|\d\s*A\b/i.test(t)) service = service || t;
    }
  }

  // Circuits, side by side.
  const circuits = [];
  let skipped = 0;
  let maxSlot = 0;
  for (const side of sides) {
    const entries = [];
    const seen = new Set();
    for (let r = hr + 1; r <= maxRow; r++) {
      const a = anchor(r, side.cct);
      const key = `${a.r}:${a.c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = /^(\d{1,3})\s*([AB])?$/i.exec(raw(a.r, a.c));
      if (!m) continue;
      const slot = Number(m[1]);
      maxSlot = Math.max(maxSlot, slot);
      entries.push({ slot, half: m[2] ? m[2].toUpperCase() : null, r1: a.r, r2: a.m ? a.m.r2 : a.r });
    }
    // Group entries that share a DESCRIPTION (else AMP) cell merged across more than one of them.
    const groups = new Map();
    for (const e of entries) {
      const spansMore = (col) => {
        if (col < 0) return null;
        const a = anchor(e.r1, col);
        return a.m && (a.m.r1 < e.r1 || a.m.r2 > e.r2) ? `${a.r}:${a.c}` : null;
      };
      const k = (spansMore(side.desc) && 'd' + spansMore(side.desc)) || (spansMore(side.amp) && 'a' + spansMore(side.amp)) || `e${e.r1}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    for (const g of groups.values()) {
      const first = g.reduce((a, b) => (b.r1 < a.r1 ? b : a));
      const description = side.desc >= 0 ? val(first.r1, side.desc) : '';
      const ampText = side.amp >= 0 ? val(first.r1, side.amp) : '';
      if (!description && !ampText) continue;
      const amp = parseAmpText(ampText);
      const base = { description, amps: amp.amps, loadVA: 0, phase: '' };
      const sorted = g.slice().sort((a, b) => a.slot - b.slot || (a.half || '').localeCompare(b.half || ''));
      const allFull = sorted.every((e) => !e.half);
      if (allFull) {
        const poles = Math.min(3, Math.max(sorted.length, amp.poles || 1));
        circuits.push({ ...base, slot: sorted[0].slot, poles, breakerType: amp.breakerType || 'standard' });
        continue;
      }
      if (sorted.length === 2 && sorted[0].half === 'B' && sorted[1].half === 'A' && sorted[1].slot === sorted[0].slot + 2) {
        circuits.push({ ...base, slot: sorted[0].slot, half: 'B', poles: 2, breakerType: 'quad' });
        continue;
      }
      if (sorted.length > 1) skipped += sorted.length - 1;
      const e = sorted[0];
      if (e.half) circuits.push({ ...base, slot: e.slot, half: e.half, poles: 1, breakerType: amp.breakerType || 'tandem' });
      else circuits.push({ ...base, slot: e.slot, poles: 1, breakerType: amp.breakerType || 'standard' });
    }
  }
  const svc = parseServiceLine(service);
  const need = Math.max(maxSlot, ...circuits.map(spanTo), 0);
  const even = need % 2 ? need + 1 : need;
  const slots = SLOT_COUNTS.find((s) => s >= even) || even || 40;
  circuits.sort((a, b) => a.slot - b.slot || (a.half || '').localeCompare(b.half || ''));
  return { name, location, voltage: svc.voltage, mainAmps: svc.mainAmps, mainType: svc.mainType, slots, circuits, skipped };
}
