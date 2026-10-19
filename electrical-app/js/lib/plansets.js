// Plan sets: a multi-page PDF imported as one drawing per sheet. Pure helpers (no DOM),
// shared by the drawings gallery, the canvas editor and the estimate takeoff.
//
// A sheet is an ordinary drawing record with
//   planSet: { id, name, page, label, pageCount, pxPerPt }
// id groups the sheets, name is the PDF's file name, page is the 1-based page in that PDF,
// label is the PDF's own page label ("E1.0") or null, pageCount is the PDF's page count and
// pxPerPt is how many canvas units one PDF point became (so a scale can move between sheets
// rendered at different sizes). Drawings without planSet are single drawings, as before.

/** World px per foot the editor starts with (canvas/editor.js normalizeDrawing). */
export const DEFAULT_SCALE = 24;

/** Layers a new drawing starts with (modules/drawings.js uses the same). */
export const DEFAULT_LAYERS = [
  { id: 'L1', name: 'Plan', visible: true, locked: false, opacity: 1 },
  { id: 'L2', name: 'Power', visible: true, locked: false, opacity: 1 },
];

/**
 * Most characters one underlay data URL may take. The drawings schema allows 20 MiB for
 * `underlay` and the server 24 MiB per record (server/src/collections.js); 8 MiB leaves room
 * for the markup, keeps a sheet to one sync batch on a slow site connection and keeps a
 * 20-sheet set within what an iPad holds in memory.
 */
export const UNDERLAY_MAX_CHARS = 8 * 1024 * 1024;

/** JPEG encodes tried in order until the underlay fits (a dense page steps down). */
export const ENCODE_STEPS = Object.freeze([
  { quality: 0.9, scale: 1 }, { quality: 0.8, scale: 1 }, { quality: 0.7, scale: 1 }, { quality: 0.6, scale: 1 },
  { quality: 0.6, scale: 0.75 }, { quality: 0.6, scale: 0.5 },
]);

const DASHES = /\s*[-‐-―]\s*/g;
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

/**
 * Read a page list like "2-9, 12" into page numbers (1-based, sorted, no repeats).
 * Also takes "all", open ranges ("5-" to the end, "-3" from the start), "p.3", and the PDF's
 * own page labels ("E1.0", "E1.0-E1.4") when `labels` (index i = page i + 1) is given.
 * @returns {{ pages: number[], error: string|null }}
 */
export function parsePageRange(text, max, labels = null) {
  const src = String(text ?? '').trim();
  if (!src) return { pages: [], error: 'Type the pages to import, for example 2-9, 12.' };
  if (/^(all|\*)$/i.test(src)) return { pages: range(1, max), error: null };
  const byLabel = new Map();
  (labels || []).forEach((l, i) => {
    const k = String(l ?? '').trim().toLowerCase();
    if (k && !byLabel.has(k)) byLabel.set(k, i + 1);
  });
  const out = new Set();
  const check = (n) => {
    if (n < 1) return 'There is no page 0.';
    if (n > max) return `Page ${n} is past the end: this PDF has ${max} page${max === 1 ? '' : 's'}.`;
    return null;
  };
  for (const tok of src.replace(DASHES, '-').split(/[\s,;]+/).filter(Boolean)) {
    const key = tok.toLowerCase();
    if (byLabel.has(key)) { out.add(byLabel.get(key)); continue; }
    let a = null, b = null;
    const num = /^p(?:age)?\.?(\d+)$/i.exec(tok) || /^(\d+)$/.exec(tok);
    const span = /^(\d*)-(\d*)$/.exec(tok);
    if (num) { a = b = Number(num[1]); }
    else if (span && (span[1] || span[2])) { a = span[1] ? Number(span[1]) : 1; b = span[2] ? Number(span[2]) : max; }
    else {
      // a range between two labels, split at whichever dash makes both halves labels
      for (let i = tok.indexOf('-'); i > 0 && a == null; i = tok.indexOf('-', i + 1)) {
        const l = key.slice(0, i), r = key.slice(i + 1);
        if (byLabel.has(l) && byLabel.has(r)) { a = byLabel.get(l); b = byLabel.get(r); }
      }
      if (a == null) return { pages: [], error: `Can't read "${tok}". Use page numbers like 2-9, 12.` };
    }
    if (a > b) [a, b] = [b, a];
    const err = check(a) || check(b);
    if (err) return { pages: [], error: err };
    for (let n = a; n <= b; n++) out.add(n);
  }
  return { pages: [...out].sort((x, y) => x - y), error: null };
}

/** [1,2,3,5,7,8,9] -> "1-3, 5, 7-9" */
export function formatPageRange(pages) {
  const ps = [...new Set((pages || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < ps.length; i++) {
    let j = i;
    while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    parts.push(j > i ? `${ps[i]}-${ps[j]}` : String(ps[i]));
    i = j;
  }
  return parts.join(', ');
}

/** The PDF's own label for a page when it says more than the page number, else null. */
export function pageLabel(labels, pageNo) {
  const l = String(labels?.[pageNo - 1] ?? '').replace(/\s+/g, ' ').trim();
  if (!l || l === String(pageNo)) return null;
  return l.slice(0, 40);
}

/** What the sheet bar and lists show: "E1.0", else "Page 3". */
export function sheetLabel(ps) {
  if (!ps) return '';
  return ps.label || `Page ${ps.page}`;
}

/** "Smith Reno IFC.pdf" -> "Smith Reno IFC" */
export function setNameFromFile(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop().replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim();
  return base.slice(0, 120) || 'Plan set';
}

/** "<set name> · E1.0", or "<set name> · p.3" when the page has no label. */
export function sheetName(setName, label, page) {
  return `${setName || 'Plan set'} · ${label || `p.${page}`}`;
}

/** The planSet field for one sheet, typed the way the drawings schema expects. */
export function makePlanSet({ id, name, page, label = null, pageCount, pxPerPt = null }) {
  return {
    id: String(id), name: String(name || 'Plan set').slice(0, 200), page: Math.max(1, Math.round(Number(page) || 1)),
    label: label ? String(label).slice(0, 40) : null, pageCount: Math.max(1, Math.round(Number(pageCount) || 1)),
    pxPerPt: Number(pxPerPt) > 0 ? Math.round(Number(pxPerPt) * 1e6) / 1e6 : null,
  };
}

/**
 * A new drawing record for one sheet. It takes the job, paper and layer setup of `base`
 * (the drawing the import started from, or the gallery's job filter) and starts unscaled.
 * @param {{ jobId?: string|null, paper?: string, layers?: object[] }} base
 * @param {ReturnType<typeof makePlanSet>} planSet
 * @param {{ url?: string, w?: number, h?: number, thumb?: string|null }} underlay
 */
export function sheetRecord(base, planSet, underlay = {}) {
  const layers = (base?.layers?.length ? base.layers : DEFAULT_LAYERS)
    .map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, locked: !!l.locked, opacity: l.opacity ?? 1 }));
  return {
    name: sheetName(planSet.name, planSet.label, planSet.page),
    jobId: base?.jobId || null, paper: base?.paper || 'grid', scale: DEFAULT_SCALE,
    layers, strokes: [], objects: [], texts: [], rooms: [],
    underlay: underlay.url || null, underlayX: 0, underlayY: 0, underlayW: underlay.w || 0, underlayH: underlay.h || 0,
    underlayOpacity: 1, underlayLocked: true, view: null, thumb: underlay.thumb || null,
    planSet,
  };
}

/** Names the app gives a new drawing ("Untitled plan 3", "Kitchen reno — plan 2"). */
export function isDefaultDrawingName(name) {
  const n = String(name ?? '').trim();
  return !n || n === 'Untitled' || /^Untitled plan \d+$/.test(n) || / — plan \d+$/.test(n);
}

/** Keep a sheet's name in step when its set is renamed (names the user changed stay). */
export function renameSheet(name, oldSetName, newSetName) {
  const prefix = `${oldSetName} · `;
  return String(name ?? '').startsWith(prefix) ? `${newSetName} · ${name.slice(prefix.length)}` : name;
}

/** Sheets in PDF page order. */
export function sortSheets(sheets) {
  return [...sheets].sort((a, b) => (a.planSet?.page ?? 0) - (b.planSet?.page ?? 0)
    || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Group drawings for the gallery. Keeps the input order: a set sits where its first sheet
 * was (the gallery sorts newest first, so where its latest edit is). A set with one sheet
 * left shows as a single drawing.
 * @returns {Array<{ kind: 'single', drawing: object } | { kind: 'set', id: string, name: string, sheets: object[], updatedAt: string }>}
 */
export function groupDrawings(drawings) {
  const out = [];
  const sets = new Map();
  for (const d of drawings || []) {
    const sid = d?.planSet?.id;
    if (!sid) { out.push({ kind: 'single', drawing: d }); continue; }
    let g = sets.get(sid);
    if (!g) { g = { kind: 'set', id: sid, name: d.planSet.name || 'Plan set', sheets: [], updatedAt: '' }; sets.set(sid, g); out.push(g); }
    g.sheets.push(d);
  }
  return out.map((g) => {
    if (g.kind !== 'set') return g;
    if (g.sheets.length === 1) return { kind: 'single', drawing: g.sheets[0] };
    const sheets = sortSheets(g.sheets);
    const updatedAt = sheets.reduce((m, s) => ((s.updatedAt || '') > m ? s.updatedAt : m), '');
    return { ...g, sheets, updatedAt };
  });
}

/** Where a sheet sits in its set: { index, count, prev, next } (prev/next are drawings or null). */
export function neighbours(sheets, id) {
  const index = sheets.findIndex((s) => s.id === id);
  return { index, count: sheets.length, prev: index > 0 ? sheets[index - 1] : null, next: index >= 0 && index < sheets.length - 1 ? sheets[index + 1] : null };
}

/** True once someone set this drawing's scale (Measure → Set scale, details, or copied from a sheet). */
export function hasOwnScale(d) {
  if (d?.scaleSet === true) return true;
  const s = Number(d?.scale);
  return s > 0 && Math.abs(s - DEFAULT_SCALE) > 1e-9;
}

/** A scale (world px per foot) moved to a sheet rendered at another size. */
export function transferScale(scale, fromPxPerPt, toPxPerPt) {
  const a = Number(fromPxPerPt), b = Number(toPxPerPt);
  if (!(a > 0) || !(b > 0)) return scale;
  return scale * (b / a);
}

/**
 * The other sheets of a set to give the source sheet's scale to.
 * @param {'unscaled'|'all'} mode  'unscaled' skips sheets that already have their own scale
 * @returns {{ id: string, scale: number }[]}
 */
export function scaleTargets(sheets, source, mode = 'unscaled') {
  const from = source?.planSet?.pxPerPt;
  return sheets
    .filter((s) => s.id !== source.id && (mode === 'all' || !hasOwnScale(s)))
    .map((s) => ({ id: s.id, scale: transferScale(source.scale, from, s.planSet?.pxPerPt) }));
}

/**
 * One takeoff for a whole set: every sheet's objects together. Circuits are per sheet, so
 * an AFCI circuit "3" on two sheets counts twice, the same as two separate takeoffs would.
 */
export function mergeForTakeoff(sheets) {
  return {
    objects: (sheets || []).flatMap((s) => (s.objects || []).map((o) => ({ ...o, circuit: `${s.id}:${o.circuit ?? '-'}` }))),
  };
}
