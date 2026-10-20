// The canvas editor (S02–S10): infinite paper, pressure pens, tool wheel,
// layers, symbols, wires, measure, rooms, auto-place, code check,
// import/export and takeoff.
import { uid } from '../store.js';
import {
  drawPaper, drawContent, drawStroke, drawObject, hitTest, itemBounds, textBounds,
  contentBounds, renderToCanvas, toSVG, takeoff, fmtWorldLength, segLen, wireLength, FREEHAND,
} from './engine.js';
import { SYMBOLS, SYMBOL_ORDER, symbolPreview } from './symbols.js';
import { createRooms, swallowNextClick, ROOM_ICON, CHECK_ICON, WAND_ICON } from './rooms.js';
import { createStabilizer, clampSmooth } from './stabilizer.js';
import { eraseStrokes, distToSeg, segSegDist } from './erase.js';
import { createTapDetector, getGesture, actionLabel, gesturePanel, tapRollback, TAP } from './gestures.js';
import { session, savePref } from '../session.js';
import { getUnits, parseLength, fmtLength, M_PER_FT } from '../lib/units.js';
import {
  makePlanSet, sheetRecord, sheetName, sheetLabel, isDefaultDrawingName, sortSheets, neighbours, scaleTargets, hasOwnScale, customerSheetRecord,
} from '../lib/plansets.js';
import { isPdf, openPdf, renderSheet, renderImage, pickPages, importPages, chooseDialog, release } from './plansets-ui.js';
import { createCollab, COLLAB_ICON } from './collab.js';

const RAW = {
  wire: '<path d="M3 18c3 0 3-12 9-12s6 12 9 12"/><circle cx="3" cy="18" r="1.6"/><circle cx="21" cy="18" r="1.6"/>',
  outlet: '<circle cx="12" cy="12" r="5.5"/><path d="M9.5 5v14M14.5 5v14"/>',
  rotate: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 4v5h-5"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  bigger: '<path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7"/>',
  smaller: '<path d="M14 10h7M14 10V3M10 14H3M10 14v7"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  dash: '<path d="M3 12h4M10 12h4M17 12h4"/>',
  curve: '<path d="M3 18C6 6 18 6 21 18"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  room: ROOM_ICON, check: CHECK_ICON, wand: WAND_ICON,
};

const WHEEL_TOOLS = [
  { id: 'pen', label: 'Pen', icon: 'pen', key: 'p' },
  { id: 'pencil', label: 'Pencil', icon: 'pencil', key: 'n' },
  { id: 'marker', label: 'Marker', icon: 'marker', key: 'k' },
  { id: 'highlighter', label: 'Highlighter', icon: 'highlighter', key: 'i' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'e' },
  { id: 'select', label: 'Select', icon: 'pointer', key: 'v' },
  { id: 'hand', label: 'Pan', icon: 'hand', key: 'h' },
  { id: 'wire', label: 'Wire', icon: RAW.wire, key: 'w' },
];
const SHAPE_TOOLS = [
  { id: 'line', label: 'Line', icon: 'line', key: 'l' },
  { id: 'rect', label: 'Rectangle', icon: 'square', key: 'r' },
  { id: 'text', label: 'Text', icon: 'type', key: 't' },
  { id: 'measure', label: 'Measure', icon: 'ruler', key: 'm' },
  { id: 'room', label: 'Room', icon: RAW.room, key: 'o' },
];
const ALL_TOOLS = [...WHEEL_TOOLS, ...SHAPE_TOOLS];

export const SWATCHES = [
  { c: '#1c1b19', n: 'Black / ink' }, { c: '#c62f2f', n: 'Red' }, { c: '#1f5fb8', n: 'Blue' }, { c: '#ffffff', n: 'White' },
  { c: '#1d7044', n: 'Green (ground)' }, { c: '#e07a1f', n: 'Orange' }, { c: '#7a4a24', n: 'Brown' }, { c: '#f5b301', n: 'Yellow' },
  { c: '#8a8478', n: 'Grey' }, { c: '#7a3fb0', n: 'Purple' }, { c: '#0e8a8a', n: 'Teal' }, { c: '#d6457a', n: 'Pink' },
];

const PAPERS = [{ id: 'none', label: 'Blank' }, { id: 'dots', label: 'Dots' }, { id: 'grid', label: 'Grid' }, { id: 'iso', label: 'Isometric' }];

// smooth: the stabilizer's 0–100 (./stabilizer.js); eraser mode: 'area' cuts strokes, 'stroke' removes them whole
const DEFAULT_OPTS = () => ({
  pen: { size: 3, opacity: 1, color: '#1c1b19', smooth: 25 },
  pencil: { size: 2, opacity: 1, color: '#5f5a51', smooth: 20 },
  marker: { size: 7, opacity: 0.9, color: '#1f5fb8', smooth: 25 },
  highlighter: { size: 20, opacity: 1, color: '#f5b301', smooth: 40 },
  eraser: { size: 18, mode: 'area' },
  line: { size: 2.5, opacity: 1, color: '#1c1b19' },
  rect: { size: 2.5, opacity: 1, color: '#1c1b19' },
  wire: { size: 2.5, opacity: 1, color: '#c62f2f' },
  text: { size: 18, opacity: 1, color: '#1c1b19' },
  measure: { size: 1.5, opacity: 1, color: '#1c1b19' },
});

/**
 * Size range per tool. Pens, shapes and text are in world units (they scale with the drawing, and
 * the preview dot shows them at the current zoom); the eraser is in screen px, so it covers the
 * same patch of glass at any zoom.
 */
export const TOOL_SIZES = {
  pen: [0.5, 24], pencil: [0.5, 16], marker: [2, 48], highlighter: [6, 80], eraser: [4, 160],
  line: [0.5, 24], rect: [0.5, 24], wire: [0.5, 16], text: [8, 96],
};
const SLIDER_STEPS = 1000;
/** Sizes step finer when small: 0.1 under 2, 0.5 under 10, then whole numbers. */
export function roundSize(v) { return v < 2 ? Math.round(v * 10) / 10 : v < 10 ? Math.round(v * 2) / 2 : Math.round(v); }
export function clampSize(tool, v) { const [lo, hi] = TOOL_SIZES[tool] || [0.5, 80]; return Math.min(hi, Math.max(lo, roundSize(Number(v) || lo))); }
// a log scale, so 0.5 to 24 is as easy to set at the small end as the big one
const sizeToSlider = (tool, v) => { const [lo, hi] = TOOL_SIZES[tool]; return Math.round((Math.log(clampSize(tool, v) / lo) / Math.log(hi / lo)) * SLIDER_STEPS); };
const sliderToSize = (tool, x) => { const [lo, hi] = TOOL_SIZES[tool]; return clampSize(tool, lo * (hi / lo) ** (x / SLIDER_STEPS)); };

/** Brush settings for this person on this device (each tool keeps its own size, smoothness, colour). */
function optsKey(ctx) {
  const who = ctx?.auth?.account?.userId || (ctx?.auth?.synced ? null : ctx?.auth?.current?.()?.id);
  return who ? `kc.canvas.opts.${who}` : 'kc.canvas.opts';
}
function loadOpts(key) {
  const def = DEFAULT_OPTS();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || localStorage.getItem('kc.canvas.opts') || '{}') || {}; } catch { /* use defaults */ }
  for (const [tool, o] of Object.entries(saved)) if (def[tool] && o && typeof o === 'object') def[tool] = { ...def[tool], ...o };
  for (const tool of Object.keys(TOOL_SIZES)) if (def[tool]) def[tool].size = clampSize(tool, def[tool].size);
  return def;
}
function saveOpts(o, key) { try { localStorage.setItem(key, JSON.stringify(o)); } catch { /* ignore */ } }

export function normalizeDrawing(d) {
  d.layers = d.layers?.length ? d.layers : [{ id: 'L1', name: 'Layer 1', visible: true, locked: false, opacity: 1 }];
  d.strokes ||= []; d.objects ||= []; d.texts ||= []; d.rooms ||= [];
  d.paper ||= 'grid';
  d.scale = Number(d.scale) > 0 ? Number(d.scale) : 24;
  if (d.underlayOpacity == null) d.underlayOpacity = 1;
  return d;
}

// PDF and image import (pdf.js loading, page picker, per-page render) lives in ./plansets-ui.js.

/** Fields the sheet bar and sheet list don't need: lists of a set's sheets leave them out. */
const SHEET_OMIT = ['underlay', 'strokes', 'texts', 'rooms', 'codeOptions', 'placement', 'view'];

export function openEditor(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h, icon } = ui;
  const rec = store.get('drawings', id);
  if (!rec) {
    root.append(ui.page({ title: 'Drawing not found' }, ui.empty({ icon: 'pen', title: 'This drawing no longer exists', action: ui.button('Back to drawings', { href: '#/drawings' }) })));
    return;
  }
  const d = normalizeDrawing(rec);
  const OPTS_KEY = optsKey(ctx);
  const opts = loadOpts(OPTS_KEY);
  const st = {
    tool: 'pen', view: d.view && !(d.view.x === 0 && d.view.y === 0 && d.view.zoom === 1) ? { ...d.view } : null,
    activeLayer: d.layers[d.layers.length - 1].id, selection: [], placing: null, placeRot: 0,
    wireDash: false, wireCurve: false, setScale: false, penSeen: false, space: false, hover: null, prevTool: null,
  };
  let undo = [], redo = [];
  let op = null;
  const pointers = new Map();
  let pinch = null;
  let underImg = null;
  let dpr = 1, W = 0, H = 0;
  let baseDirty = true, rafId = 0, saveTimer = 0, contentDirty = false, destroyed = false;
  let rooms = null; // rooms, auto-place and code check (./rooms.js), created once the DOM exists
  let collab = null; // who drew what, change history, cost impact, merge (./collab.js)
  const seesMoney = ctx.auth.seesMoney?.() ?? false;

  root.classList.add('full-bleed');
  document.body.classList.add('canvas-open');

  // ---------- DOM ----------
  const canvas = h('canvas', { class: 'cv-canvas', 'aria-label': 'Drawing canvas', role: 'img' });
  const base = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const bg = base.getContext('2d');

  const btn = (ic, label, onClick, extra = {}) => h('button', { class: ['cv-btn', extra.class], type: 'button', title: label, 'aria-label': label, onClick, ...extra.attrs }, icon(ic, extra.size || 20), extra.text ? h('span', null, extra.text) : null);

  const undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => doUndo());
  const redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z)', () => doRedo());
  const titleBtn = h('button', { class: 'cv-title', type: 'button', title: 'Drawing details', onClick: () => detailsSheet() });
  const paperBtn = btn('grid', 'Paper type', () => cyclePaper(), { class: 'wide-only' });

  const topLeft = h('div', { class: 'cv-bar cv-top-left' },
    btn('chevron-left', 'Back to drawings', () => {
      flushSave();
      // back to the gallery with this sheet's set opened up
      const qs = [d.jobId ? 'jobId=' + encodeURIComponent(d.jobId) : null, d.planSet?.id ? 'set=' + encodeURIComponent(d.planSet.id) : null].filter(Boolean).join('&');
      nav('#/drawings' + (qs ? '?' + qs : ''));
    }),
    titleBtn);
  const topRight = h('div', { class: 'cv-bar cv-top-right' },
    undoBtn, redoBtn, h('span', { class: 'cv-sep' }),
    btn(RAW.outlet, 'Symbols', () => symbolsSheet(), { class: 'wide-only' }),
    btn('layers', 'Layers', () => layersSheet()),
    paperBtn,
    btn('upload', 'Import plan (image or PDF)', () => importUnderlay(), { class: 'wide-only' }),
    btn(RAW.check, 'Code check (CEC)', () => rooms.openCheck()),
    btn(COLLAB_ICON, 'Changes and who drew what', () => collab.open()),
    btn('list', 'Takeoff', () => takeoffSheet(), { class: 'wide-only' }),
    btn('download', 'Export PNG', () => exportPNG(), { class: 'wide-only' }),
    btn('more', 'More', () => moreSheet()));
  const ctxBar = h('div', { class: 'cv-bar cv-ctx', hidden: true });

  const toolButtons = new Map();
  const shapes = h('div', { class: 'cv-bar cv-shapes', role: 'toolbar', 'aria-label': 'Shapes' },
    SHAPE_TOOLS.map((t) => { const b = btn(t.icon, `${t.label} (${t.key.toUpperCase()})`, () => setTool(t.id)); toolButtons.set(t.id, b); return b; }),
    h('span', { class: 'cv-sep h' }),
    btn(RAW.outlet, 'Place a symbol', () => symbolsSheet()));

  // tool wheel
  const wheel = h('div', { class: 'cv-wheel', role: 'toolbar', 'aria-label': 'Tool wheel' });
  WHEEL_TOOLS.forEach((t, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / WHEEL_TOOLS.length;
    const b = h('button', {
      class: 'cv-wheel-tool', type: 'button', title: `${t.label} (${t.key.toUpperCase()})`, 'aria-label': t.label,
      style: { left: `calc(50% + ${Math.cos(a) * 38}% )`, top: `calc(50% + ${Math.sin(a) * 38}% )` },
      onClick: () => setTool(t.id),
    }, icon(t.icon, 19));
    toolButtons.set(t.id, b);
    wheel.append(b);
  });
  const centerDot = h('span', { class: 'cv-dot' });
  const centerRing = h('span', { class: 'cv-ring' });
  const centerLabel = h('span', { class: 'cv-wheel-label' });
  const center = h('button', { class: 'cv-wheel-center', type: 'button', title: 'Colour, size and opacity', 'aria-label': 'Colour, size and opacity', onClick: () => togglePop() }, centerRing, centerDot, centerLabel);
  wheel.append(center);

  // brush popover
  const pop = h('div', { class: 'cv-pop', hidden: true, role: 'dialog', 'aria-label': 'Brush settings' });

  const zoomLabel = h('button', { class: 'cv-zoom-label', type: 'button', title: 'Reset to 100%', onClick: () => zoomTo(1) });
  const zoomBar = h('div', { class: 'cv-bar cv-zoom' },
    btn('minus', 'Zoom out', () => zoomBy(1 / 1.25), { size: 18 }), zoomLabel, btn('plus', 'Zoom in', () => zoomBy(1.25), { size: 18 }),
    h('span', { class: 'cv-sep' }), btn(RAW.fit, 'Fit drawing (0)', () => fit(), { size: 18 }));

  // plan set: previous / sheet list / next (only on drawings that are sheets of a set)
  const sheetPrev = btn('chevron-left', 'Previous sheet (Page Up)', () => goSheet(-1));
  const sheetNext = btn('chevron-right', 'Next sheet (Page Down)', () => goSheet(1));
  const sheetLabelBtn = h('button', { class: 'cv-sheet-label', type: 'button', onClick: () => sheetsSheet() });
  const sheetBar = h('nav', { class: 'cv-bar cv-sheetbar', 'aria-label': 'Sheets in this plan set', hidden: true }, sheetPrev, sheetLabelBtn, sheetNext);

  // quick size: bigger / the brush at its size (opens the settings) / smaller, for the tool in hand
  const sizeUp = btn('plus', 'Bigger', () => stepSize(1), { size: 18 });
  const sizeDown = btn('minus', 'Smaller', () => stepSize(-1), { size: 18 });
  const sizeDotBtn = h('button', { class: 'cv-sizebar-dot', type: 'button', title: 'Size and brush settings', 'aria-label': 'Size and brush settings', onClick: () => togglePop(pop.hidden) });
  const sizeBar = h('div', { class: 'cv-bar cv-sizebar', role: 'group', 'aria-label': 'Brush size' }, sizeUp, sizeDotBtn, sizeDown);

  const wrap = h('div', { class: 'cv' }, canvas, topLeft, topRight, ctxBar, shapes, wheel, sizeBar, pop, zoomBar, sheetBar);
  root.append(wrap);

  // ---------- helpers ----------
  const z = () => st.view.zoom;
  const toWorld = (sx, sy) => [(sx - st.view.x) / st.view.zoom, (sy - st.view.y) / st.view.zoom];
  const layerOf = (lid) => d.layers.find((l) => l.id === lid);
  const usable = (l) => l.visible !== false && !l.locked;
  const COLL = { stroke: () => d.strokes, object: () => d.objects, text: () => d.texts, room: () => d.rooms };
  const units = () => getUnits(store.settings().units);
  const findSel = (s) => COLL[s.kind]().find((i) => i.id === s.id);
  const isDark = () => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    return m ? parseInt(m[1].slice(0, 2), 16) < 90 : false;
  };
  const paperColors = () => {
    const cs = getComputedStyle(document.documentElement);
    return { bg: cs.getPropertyValue('--paper').trim() || '#f7f6f2', line: cs.getPropertyValue('--paper-line').trim() || 'rgba(0,0,0,.1)' };
  };
  const curOpts = () => opts[st.tool] || opts.pen;

  function snapshot() {
    return {
      json: JSON.stringify({ layers: d.layers, strokes: d.strokes, objects: d.objects, texts: d.texts, rooms: d.rooms, codeOptions: d.codeOptions ?? null, placement: d.placement ?? null, paper: d.paper, scale: d.scale,
        underlayX: d.underlayX, underlayY: d.underlayY, underlayW: d.underlayW, underlayH: d.underlayH, underlayOpacity: d.underlayOpacity, underlayLocked: d.underlayLocked,
        ...(d.scaleSet !== undefined ? { scaleSet: d.scaleSet } : {}), ...(d.planSet !== undefined ? { planSet: d.planSet } : {}) }),
      underlay: d.underlay,
    };
  }
  function restore(s) {
    const snap = JSON.parse(s.json);
    const setBefore = d.planSet?.id;
    // undoing back past a plan set import: null (not delete) so the saved record loses it too
    for (const k of ['planSet', 'scaleSet']) if (!(k in snap) && d[k] != null) d[k] = null;
    Object.assign(d, snap);
    if (d.planSet?.id !== setBefore) renderSheetBar();
    if (d.underlay !== s.underlay) { d.underlay = s.underlay; loadUnderlay(); }
    if (!layerOf(st.activeLayer)) st.activeLayer = d.layers[d.layers.length - 1].id;
    st.selection = st.selection.filter((x) => findSel(x));
  }
  function checkpoint() {
    undo.push(snapshot());
    if (undo.length > 80) undo.shift();
    redo = [];
  }
  function doUndo() {
    if (op?.type === 'wire') { op = null; return changed(false); }
    if (!undo.length) return;
    redo.push(snapshot()); restore(undo.pop()); changed();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(snapshot()); restore(redo.pop()); changed();
  }

  function changed(content = true) {
    baseDirty = true;
    if (content) { contentDirty = true; rooms?.onChanged(); collab?.onChanged(); }
    scheduleSave();
    updateChrome();
    requestFrame();
  }
  function viewChanged() { baseDirty = true; scheduleSave(); updateZoom(); requestFrame(); }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!store.count('drawings', (x) => x.id === id)) return; // deleted (count: no copy of the underlay)
    const patch = {
      name: d.name, jobId: d.jobId || null, paper: d.paper, scale: d.scale, layers: d.layers, strokes: d.strokes, objects: d.objects, texts: d.texts,
      rooms: d.rooms, codeOptions: d.codeOptions || null, placement: d.placement || null,
      underlay: d.underlay || null, underlayX: d.underlayX || 0, underlayY: d.underlayY || 0, underlayW: d.underlayW || 0, underlayH: d.underlayH || 0,
      underlayOpacity: d.underlayOpacity, underlayLocked: !!d.underlayLocked, view: st.view ? { ...st.view } : null,
    };
    // only on drawings that have them, so older drawings don't gain empty fields
    if (d.scaleSet !== undefined) patch.scaleSet = d.scaleSet;
    if (d.planSet !== undefined) patch.planSet = d.planSet;
    if (d.clientId !== undefined) patch.clientId = d.clientId;
    // who drew what: stamp changed items, record history and tombstones (./collab.js)
    collab?.beforeSave(patch, contentDirty);
    if (contentDirty) {
      contentDirty = false;
      try {
        const has = contentBounds(d);
        patch.thumb = has ? renderToCanvas(d, { fixed: { w: 360, h: 240 }, pad: 24, underlayImage: underImg, units: units() }).toDataURL('image/jpeg', 0.72) : null;
      } catch { /* thumbnail is optional */ }
    }
    store.update('drawings', id, patch, { silent: true });
  }
  function flushSave() { if (saveTimer) save(); }

  function loadUnderlay() {
    underImg = null;
    if (!d.underlay) return;
    const img = new Image();
    img.onload = () => {
      if (!d.underlayW) { d.underlayW = img.naturalWidth; d.underlayH = img.naturalHeight; }
      baseDirty = true; requestFrame();
    };
    img.src = d.underlay;
    underImg = img;
  }

  // ---------- render ----------
  function resize() {
    const r = wrap.getBoundingClientRect();
    dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    for (const c of [canvas, base]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    if (!st.view) fit(true);
    baseDirty = true;
    requestFrame();
  }

  function requestFrame() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(frame);
  }

  function renderBase() {
    baseDirty = false;
    const v = st.view;
    bg.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPaper(bg, v, W, H, d.paper, paperColors());
    bg.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.x, dpr * v.y);
    drawContent(bg, d, { zoom: v.zoom, dark: isDark(), underlayImage: underImg, units: units() });
  }

  function frame() {
    rafId = 0;
    if (destroyed || !st.view) return;
    if (baseDirty) renderBase();
    const v = st.view, dark = isDark();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(base, 0, 0);
    g.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.x, dpr * v.y);
    const al = layerOf(st.activeLayer);
    g.globalAlpha = al?.opacity ?? 1;
    if (op?.stroke) drawStroke(g, op.pred ? { ...op.stroke, points: [...op.stroke.points, ...op.pred] } : op.stroke, d, { zoom: v.zoom, dark, units: units() });
    if (op?.type === 'wire') {
      const pts = op.hover ? [...op.points, op.hover] : op.points;
      if (pts.length > 1) drawStroke(g, { ...op.proto, points: pts }, d, { zoom: v.zoom, dark, units: units() });
      g.globalAlpha = 1;
      if (op.hover && d.scale > 0) label(g, op.hover, fmtWorldLength(wireLength(pts), d, units()));
    }
    g.globalAlpha = 1;
    // snap target highlight
    if (st.snap) { g.strokeStyle = '#f5b301'; g.lineWidth = 2 / v.zoom; g.beginPath(); g.arc(st.snap[0], st.snap[1], 9 / v.zoom, 0, Math.PI * 2); g.stroke(); }
    // placing ghost
    if (st.placing && st.hover) { g.globalAlpha = 0.5; drawObject(g, { symbol: st.placing, x: st.hover[0], y: st.hover[1], rotation: st.placeRot, scale: 1 }, { dark }); g.globalAlpha = 1; }
    // selection
    g.setLineDash([5 / v.zoom, 4 / v.zoom]);
    g.strokeStyle = '#f5b301';
    g.lineWidth = 1.5 / v.zoom;
    const pad = 4 / v.zoom;
    for (const s of st.selection) {
      const it = findSel(s);
      if (!it) continue;
      const b = itemBounds(s.kind, it);
      g.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
    }
    if (op?.type === 'box') {
      const [a, b] = [op.a, op.b];
      g.fillStyle = 'rgba(245,179,1,0.10)';
      g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
    g.setLineDash([]);
    // rooms: drafts, handles, ghosts and code-check markers
    rooms.overlay(g);
    collab.overlay(g);
    // eraser cursor
    if (st.tool === 'eraser' && st.hover && !st.placing) {
      g.strokeStyle = dark ? '#ecebe7' : '#1c1b19'; g.lineWidth = 1 / v.zoom;
      g.beginPath(); g.arc(st.hover[0], st.hover[1], opts.eraser.size / 2 / v.zoom, 0, Math.PI * 2); g.stroke();
    }
  }

  function label(c, p, text) {
    const zz = z();
    c.save();
    c.font = `600 ${12 / zz}px Inter, system-ui, sans-serif`;
    const tw = c.measureText(text).width;
    const x = p[0] + 12 / zz, y = p[1] - 22 / zz;
    c.fillStyle = '#1c1b19';
    c.fillRect(x - 5 / zz, y - 2 / zz, tw + 10 / zz, 18 / zz);
    c.fillStyle = '#f5b301';
    c.textBaseline = 'top';
    c.fillText(text, x, y + 1 / zz);
    c.restore();
  }

  // ---------- view ----------
  function zoomAt(sx, sy, factor) {
    const v = st.view;
    const nz = Math.min(24, Math.max(0.05, v.zoom * factor));
    const [wx, wy] = toWorld(sx, sy);
    v.zoom = nz; v.x = sx - wx * nz; v.y = sy - wy * nz;
    viewChanged();
  }
  function zoomBy(f) { zoomAt(W / 2, H / 2, f); }
  function centerOn(x, y, zoom = z()) {
    const nz = Math.min(24, Math.max(0.05, zoom));
    const panelW = W > 760 ? 340 : 0, botPad = W > 760 ? 0 : H * 0.42;
    st.view = { zoom: nz, x: (W - panelW) / 2 - x * nz, y: (H - botPad) / 2 - y * nz };
    viewChanged();
  }
  function zoomTo(nz) { zoomAt(W / 2, H / 2, nz / z()); }
  function fit(initial) {
    const b = contentBounds(d);
    const topPad = 76, botPad = W < 700 ? 200 : 110, sidePad = 40;
    if (!b) { st.view = { x: W / 2 - 200, y: H / 2 - 150, zoom: 1 }; if (!initial) viewChanged(); return; }
    const bw = Math.max(40, b.x1 - b.x0), bh = Math.max(40, b.y1 - b.y0);
    const zoom = Math.min(2, Math.max(0.05, Math.min((W - sidePad * 2) / bw, (H - topPad - botPad) / bh)));
    st.view = { zoom, x: (W - bw * zoom) / 2 - b.x0 * zoom, y: topPad + (H - topPad - botPad - bh * zoom) / 2 - b.y0 * zoom };
    if (!initial) viewChanged(); else updateZoom();
  }

  // ---------- tools ----------
  function setTool(t) {
    if (op?.type === 'wire') finishWire();
    if (t !== st.tool) st.prevTool = st.tool;
    st.tool = t;
    rooms?.toolChanged();
    st.placing = null;
    st.setScale = false;
    if (t !== 'select') st.selection = [];
    pop.hidden = true;
    updateChrome();
    requestFrame();
  }

  function needLayer() {
    const l = layerOf(st.activeLayer);
    if (!l) return false;
    if (l.visible === false) { ui.toast('The active layer is hidden. Show it or pick another in Layers.', 'error'); return false; }
    if (l.locked) { ui.toast('The active layer is locked. Unlock it in Layers.', 'error'); return false; }
    return true;
  }

  function snapPoint(wx, wy) {
    const tol = 22 / z();
    let best = null, bd = tol;
    for (const o of d.objects) {
      const l = layerOf(o.layer);
      if (!l || l.visible === false) continue;
      const dd = Math.hypot(o.x - wx, o.y - wy);
      if (dd < bd) { bd = dd; best = [o.x, o.y]; }
    }
    if (!best) {
      for (const s of d.strokes) {
        if (s.tool !== 'wire') continue;
        for (const p of [s.points[0], s.points[s.points.length - 1]]) {
          const dd = Math.hypot(p[0] - wx, p[1] - wy);
          if (dd < bd * 0.6) { bd = dd; best = [p[0], p[1]]; }
        }
      }
    }
    return best;
  }

  function finishWire() {
    if (op?.type !== 'wire') return;
    const pts = op.points;
    op = null; st.snap = null;
    if (pts.length >= 2) {
      checkpoint();
      d.strokes.push({ ...cloneProto(), points: pts.map((p) => [p[0], p[1], 0.5]) });
      changed();
    } else { updateChrome(); requestFrame(); }
  }
  function cloneProto() {
    const o = opts.wire;
    return { id: uid(), layer: st.activeLayer, tool: 'wire', color: o.color, size: o.size, opacity: o.opacity, dash: st.wireDash, curve: st.wireCurve };
  }

  /**
   * Erase along the eraser's path from a to b (world): the circle swept between two samples, so a
   * fast swipe misses nothing. Area mode cuts strokes and keeps what is outside (./erase.js); whole
   * mode removes every stroke touched. Symbols and labels always go whole. The first change of a
   * drag takes the undo checkpoint, so one undo brings back everything the drag erased.
   * @returns {boolean} whether anything changed
   */
  function eraseSweep(a, b) {
    const r = opts.eraser.size / 2 / z();
    const ok = (lid) => { const l = layerOf(lid); return l && usable(l); };
    const mode = opts.eraser.mode === 'stroke' ? 'stroke' : 'area';
    const res = eraseStrokes(d.strokes, a, b, r, { mode, canErase: (s) => ok(s.layer), newId: uid, minLen: 1 / z() });
    const hitO = d.objects.filter((o) => ok(o.layer) && distToSeg(o.x, o.y, a[0], a[1], b[0], b[1]) <= 15 * (o.scale || 1) + r);
    const hitT = d.texts.filter((t) => {
      if (!ok(t.layer)) return false;
      const x = textBounds(t);
      const inside = (p) => p[0] >= x.x0 && p[0] <= x.x1 && p[1] >= x.y0 && p[1] <= x.y1;
      if (inside(a) || inside(b)) return true;
      const c = [[x.x0, x.y0], [x.x1, x.y0], [x.x1, x.y1], [x.x0, x.y1]];
      return c.some((p, i) => { const q = c[(i + 1) % 4]; return segSegDist(p[0], p[1], q[0], q[1], a[0], a[1], b[0], b[1]) <= r; });
    });
    if (!res.changed && !hitO.length && !hitT.length) return false;
    if (!op.cp) { checkpoint(); op.cp = true; }
    d.strokes = res.strokes;
    if (hitO.length || hitT.length) {
      const gone = new Set([...hitO, ...hitT].map((x) => x.id));
      d.objects = d.objects.filter((o) => !gone.has(o.id));
      d.texts = d.texts.filter((t) => !gone.has(t.id));
    }
    return true;
  }

  function translateSel(dx, dy) {
    for (const s of st.selection) {
      const it = findSel(s);
      if (!it) continue;
      if (s.kind === 'stroke') it.points = it.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]);
      else if (s.kind === 'room') moveRoom(it, dx, dy);
      else { it.x += dx; it.y += dy; }
    }
  }
  function moveRoom(r, dx, dy) {
    r.points = r.points.map((p) => [p[0] + dx, p[1] + dy]);
    for (const f of r.features || []) if (f.kind === 'island') { f.x += dx; f.y += dy; }
  }

  function inUnderlay(wx, wy) {
    return d.underlay && d.underlayW && !d.underlayLocked && wx >= (d.underlayX || 0) && wy >= (d.underlayY || 0)
      && wx <= (d.underlayX || 0) + d.underlayW && wy <= (d.underlayY || 0) + d.underlayH;
  }

  async function addText(wx, wy) {
    if (!needLayer()) return;
    const text = await ui.promptDialog('Label text', { title: 'Add a label', okLabel: 'Add' });
    if (!text || !text.trim()) return;
    checkpoint();
    const o = opts.text;
    d.texts.push({ id: uid(), layer: st.activeLayer, x: wx, y: wy, text: text.trim(), color: o.color, size: o.size });
    changed();
  }
  /** The text tool at a point: edit the label there, or add one. */
  function textAt(wx, wy) {
    const hit = hitTest(d, wx, wy, 4 / z(), usable);
    swallowNextClick();
    if (hit?.kind === 'text') editText(hit.item); else addText(wx, wy);
  }
  async function editText(t) {
    const text = await ui.promptDialog('Label text', { title: 'Edit label', value: t.text, okLabel: 'Save' });
    if (text == null) return;
    checkpoint();
    if (!text.trim()) d.texts = d.texts.filter((x) => x.id !== t.id);
    else t.text = text.trim();
    changed();
  }

  // ---------- pointer input ----------
  // Every op except a wire belongs to the pointer that started it (op.pid): another pointer
  // moving or lifting (a resting palm, a second finger) never adds to it or ends it.
  // Palm rejection: while the Pencil is on the glass, and for a moment after it lifts between
  // letters, a new touch is a resting hand. It is ignored until it lifts; the pen never is.
  const PALM_MS = 350;
  let penDown = null; // pointerId of the Pencil while it touches
  let penUpAt = -Infinity;
  const palms = new Set();
  function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  const owns = (e) => !op || op.pid == null || op.pid === e.pointerId;

  // Finger gestures (./gestures.js): a two- or three-finger tap and a one-finger hold run the
  // person's chosen action. Palms never reach the detector, and the Pencil touching down cancels
  // any tap in progress. A tap's fingers start a pinch like any two fingers; if they turn out to
  // be a tap, the view goes back to where it was, and so does anything the first finger did with
  // the tool before the others landed (in finger-drawing mode: an erase, a symbol, a move).
  const taps = createTapDetector();
  let holdTimer = 0, tapView = null, tapMark = null;

  function takeBackTapFinger() {
    const back = tapRollback(tapMark, undo);
    tapMark = null;
    if (!back) return;
    restore(back.snap); undo = back.undo; redo = back.redo; changed();
  }

  function runGesture(key, view0) {
    const act = getGesture(key);
    if (act === 'none') return;
    if (view0 && st.view && (view0.zoom !== st.view.zoom || view0.x !== st.view.x || view0.y !== st.view.y)) { st.view = view0; viewChanged(); }
    let msg = actionLabel(act);
    if (act === 'undo') { if (!undo.length && op?.type !== 'wire') msg = 'Nothing to undo'; else doUndo(); }
    else if (act === 'redo') { if (!redo.length) msg = 'Nothing to redo'; else doRedo(); }
    else if (act === 'wheel') msg = wrap.classList.toggle('wheel-min') ? 'Tool wheel hidden' : 'Tool wheel';
    else if (act === 'lastTool') {
      if (!st.prevTool) msg = 'No other tool yet';
      else { setTool(st.prevTool); msg = ALL_TOOLS.find((t) => t.id === st.tool)?.label || msg; }
    } else if (act === 'fit') fit();
    ui.toast(msg, 'info', 1200);
    if (globalThis.kelbeCanvas?.d === d) globalThis.kelbeCanvas.lastGesture = { key, act };
  }
  function onHold() {
    // a finger that is drawing keeps drawing; one that pans (or rests) can be a hold
    if (op && op.type !== 'pan') return;
    if (!taps.holdDue(performance.now())) return;
    if (op?.type === 'pan') { if (st.view && op.vx != null) { st.view.x = op.vx; st.view.y = op.vy; viewChanged(); } op = null; wrap.classList.remove('panning'); }
    runGesture('longPress');
  }

  function onDown(e) {
    const pen = e.pointerType === 'pen', touch = e.pointerType === 'touch';
    if (touch && (penDown != null || (st.penSeen && performance.now() - penUpAt < PALM_MS))) { palms.add(e.pointerId); return; }
    if (e.isPrimary) {
      // first contact of its kind: anything of that kind still listed lost its pointerup
      for (const [pid, p] of pointers) if (p.type === e.pointerType) pointers.delete(pid);
      if (touch) { pinch = null; palms.clear(); taps.cancel(); }
    }
    if (pen) { taps.cancel(); clearTimeout(holdTimer); }
    if (touch) {
      const [tx, ty] = local(e);
      if (!taps.active) { tapView = st.view ? { ...st.view } : null; tapMark = { undo: undo.slice(), redo: redo.slice() }; }
      taps.down(e.pointerId, tx, ty, e.timeStamp);
      clearTimeout(holdTimer);
      if (taps.active === 1 && getGesture('longPress') !== 'none') holdTimer = setTimeout(onHold, TAP.holdMs + 20);
    }
    if (pen) {
      st.penSeen = true;
      penDown = e.pointerId;
      // the pen wins: end a pinch, and fingers already down become palms
      pinch = null;
      for (const [pid, p] of pointers) if (p.type === 'touch') { pointers.delete(pid); palms.add(pid); }
      if (op && op.type !== 'wire' && op.pid !== e.pointerId) { op = null; wrap.classList.remove('panning'); }
      // a focused text field would let iPadOS Scribble take the Pencil's handwriting
      const ae = document.activeElement;
      if (ae && ae !== document.body && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) ae.blur();
    }
    pop.hidden = true;
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const touches = [...pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length >= 2) {
      // second finger: abandon any stroke in progress and start a pinch
      if (op?.type !== 'wire') op = null; // moves/erases already applied stay applied
      rooms.cancelGesture();
      startPinch(touches);
      requestFrame();
      return;
    }
    if (pinch) return;
    const [wx, wy] = toWorld(sx, sy);
    const panTool = e.button === 1 || st.space || st.tool === 'hand' || (touch && st.penSeen);
    if (panTool) { op = { type: 'pan', pid: e.pointerId, sx, sy, vx: st.view.x, vy: st.view.y }; wrap.classList.add('panning'); return; }
    if (e.button === 2) return;
    if (!st.placing && rooms.down(e, wx, wy)) { op = null; updateChrome(); requestFrame(); return; }

    if (st.placing) {
      if (!needLayer()) return;
      checkpoint();
      d.objects.push({ id: uid(), layer: st.activeLayer, symbol: st.placing, x: wx, y: wy, rotation: st.placeRot, scale: 1 });
      changed();
      return;
    }

    const t = st.tool;
    if (FREEHAND.has(t)) {
      if (!needLayer()) return;
      const o = opts[t];
      const p = pen ? (e.pressure || 0.5) : 0.5;
      // the stabilizer owns the points: it may rewrite the last few when it finds a corner
      const stab = createStabilizer({ smoothness: o.smooth ?? 0, zoom: z(), minDist: 0.8 / z() });
      stab.add([wx, wy, p], e.timeStamp);
      op = { type: 'draw', pid: e.pointerId, start: [wx, wy], last: [wx, wy, p], stab, stroke: { id: uid(), layer: st.activeLayer, tool: t, color: o.color, size: o.size, opacity: o.opacity, points: stab.points } };
    } else if (t === 'line' || t === 'rect' || t === 'measure') {
      if (!st.setScale && !needLayer()) return;
      const o = opts[t];
      op = { type: 'shape', pid: e.pointerId, stroke: { id: uid(), layer: st.activeLayer, tool: t, color: o.color, size: o.size, opacity: o.opacity, points: [[wx, wy, 0.5], [wx, wy, 0.5]] } };
    } else if (t === 'wire') {
      if (!needLayer()) return;
      const sp = snapPoint(wx, wy) || [wx, wy];
      if (op?.type !== 'wire') { op = { type: 'wire', points: [sp], proto: cloneProto(), hover: null }; }
      else {
        const last = op.points[op.points.length - 1];
        if (Math.hypot(last[0] - sp[0], last[1] - sp[1]) < 10 / z()) { finishWire(); return; }
        op.points.push(sp);
      }
      updateChrome();
    } else if (t === 'text') {
      // a finger waits for its lift: it may be the first finger of a two-finger tap
      if (touch) op = { type: 'text', pid: e.pointerId, at: [wx, wy] };
      else textAt(wx, wy);
    } else if (t === 'eraser') {
      op = { type: 'erase', pid: e.pointerId, cp: false, lastW: [wx, wy] };
      if (eraseSweep([wx, wy], [wx, wy])) changed();
    } else if (t === 'select') {
      const hit = hitTest(d, wx, wy, 6 / z(), usable);
      if (hit) {
        const key = { kind: hit.kind, id: hit.item.id };
        const inSel = st.selection.some((s) => s.id === key.id);
        if (e.shiftKey) st.selection = inSel ? st.selection.filter((s) => s.id !== key.id) : [...st.selection, key];
        else if (!inSel) st.selection = [key];
        op = { type: 'move', pid: e.pointerId, last: [wx, wy], cp: false };
        if (e.detail >= 2 && hit.kind === 'text') { op = null; swallowNextClick(); editText(hit.item); }
      } else if (inUnderlay(wx, wy) && !e.shiftKey && st.selection.length === 0) {
        op = { type: 'underlay', pid: e.pointerId, last: [wx, wy], cp: false };
      } else {
        if (!e.shiftKey) st.selection = [];
        op = { type: 'box', pid: e.pointerId, a: [wx, wy], b: [wx, wy], add: e.shiftKey };
      }
      updateChrome();
    }
    requestFrame();
  }

  function onMove(e) {
    if (palms.has(e.pointerId)) return;
    const [sx, sy] = local(e);
    if (e.pointerType === 'touch') taps.move(e.pointerId, sx, sy);
    if (pointers.has(e.pointerId)) { const p = pointers.get(e.pointerId); p.x = sx; p.y = sy; }
    if (pinch) { movePinch(); return; }
    if (!owns(e)) return;
    const [wx, wy] = toWorld(sx, sy);
    st.hover = [wx, wy];
    if ((!op || op.type !== 'pan') && rooms.move(e, wx, wy, pointers.has(e.pointerId))) { requestFrame(); return; }
    if (!op) {
      if (st.tool === 'eraser' || st.placing) requestFrame();
      return;
    }
    switch (op.type) {
      case 'pan':
        st.view.x = op.vx + (sx - op.sx); st.view.y = op.vy + (sy - op.sy);
        viewChanged();
        break;
      case 'draw': {
        const pts = op.stroke.points;
        if (e.shiftKey || op.straight) { op.stroke.points = [pts[0], [wx, wy, pts[0][2]]]; op.straight = true; break; }
        // every sample since the last frame (a fast V can be only a few events apart otherwise),
        // through the stabilizer, which keeps corner tips exactly where they were (./stabilizer.js)
        let evs = e.getCoalescedEvents?.();
        if (!evs?.length) evs = [e];
        for (const ev of evs) {
          const [qx, qy] = toWorld(...local(ev));
          op.last = [qx, qy, ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5];
          op.stab.add(op.last, ev.timeStamp);
        }
        // where the pen is heading, drawn this frame only (raw ink only: smoothed ink trails the tip on purpose)
        const pred = op.stab.smoothness ? [] : e.getPredictedEvents?.() || [];
        op.pred = pred.length ? pred.map((ev) => [...toWorld(...local(ev)), op.last[2]]) : null;
        break;
      }
      case 'shape': {
        const a = op.stroke.points[0];
        let bx = wx, by = wy;
        if (e.shiftKey || op.stroke.tool === 'measure') {
          if (op.stroke.tool === 'rect') { const s = Math.max(Math.abs(wx - a[0]), Math.abs(wy - a[1])); bx = a[0] + Math.sign(wx - a[0]) * s; by = a[1] + Math.sign(wy - a[1]) * s; }
          else if (e.shiftKey) {
            const ang = Math.round(Math.atan2(wy - a[1], wx - a[0]) / (Math.PI / 12)) * (Math.PI / 12);
            const len = Math.hypot(wx - a[0], wy - a[1]);
            bx = a[0] + Math.cos(ang) * len; by = a[1] + Math.sin(ang) * len;
          }
        }
        op.stroke.points[1] = [bx, by, 0.5];
        break;
      }
      case 'wire': {
        const sp = snapPoint(wx, wy);
        st.snap = sp;
        op.hover = sp || [wx, wy];
        break;
      }
      case 'erase': {
        // every sample since the last frame, each swept from the one before
        let evs = e.getCoalescedEvents?.();
        if (!evs?.length) evs = [e];
        let any = false;
        for (const ev of evs) {
          const p = toWorld(...local(ev));
          if (eraseSweep(op.lastW || p, p)) any = true;
          op.lastW = p;
        }
        if (any) changed();
        break;
      }
      case 'move': {
        const dx = wx - op.last[0], dy = wy - op.last[1];
        if (!dx && !dy) break;
        if (!op.cp) { checkpoint(); op.cp = true; }
        translateSel(dx, dy);
        op.last = [wx, wy];
        changed();
        break;
      }
      case 'underlay': {
        const dx = wx - op.last[0], dy = wy - op.last[1];
        if (!op.cp) { checkpoint(); op.cp = true; }
        d.underlayX = (d.underlayX || 0) + dx; d.underlayY = (d.underlayY || 0) + dy;
        op.last = [wx, wy];
        changed();
        break;
      }
      case 'box': op.b = [wx, wy]; break;
      default: break;
    }
    requestFrame();
  }

  async function onUp(e) {
    if (palms.delete(e.pointerId)) return;
    if (e.pointerId === penDown) { penDown = null; penUpAt = performance.now(); }
    pointers.delete(e.pointerId);
    if (e.pointerType === 'touch') {
      const n = e.type === 'pointercancel' ? (taps.cancel(), null) : taps.up(e.pointerId, e.timeStamp);
      if (!taps.active) clearTimeout(holdTimer);
      if (n) { pinch = null; if (op?.type !== 'wire') op = null; wrap.classList.remove('panning'); takeBackTapFinger(); runGesture(n === 2 ? 'twoFingerTap' : 'threeFingerTap', tapView); return; }
    }
    if (pinch) {
      if ([...pointers.values()].filter((p) => p.type === 'touch').length < 2) pinch = null;
      return;
    }
    if (!owns(e)) return; // another pointer's lift doesn't end this op
    wrap.classList.remove('panning');
    if (op?.type !== 'pan' && rooms.up(e)) { updateChrome(); requestFrame(); return; }
    if (!op) return;
    const cur = op;
    if (cur.type === 'wire') return; // wires are click-by-click
    op = null;
    // A cancelled finger stroke is usually a gesture starting; drop it. A cancelled Pencil or
    // mouse stroke (iPadOS taking the stroke for Scribble or a system gesture) keeps what was drawn.
    const cancelled = e.type === 'pointercancel';
    if (cancelled && (cur.type === 'shape' || (cur.type === 'draw' && e.pointerType === 'touch'))) { requestFrame(); return; }
    if (cur.type === 'text') { if (!cancelled) textAt(...cur.at); return; }
    if (cur.type === 'draw') {
      const s = cur.stroke;
      if (!cur.straight) cur.stab.end(cur.last); // catch up to the last sample, not e: a cancel's coordinates can be 0,0
      if (s.points.length === 1) s.points.push([s.points[0][0] + 0.01, s.points[0][1], s.points[0][2]]);
      checkpoint(); d.strokes.push(s); changed();
    } else if (cur.type === 'shape') {
      const s = cur.stroke;
      const len = segLen(s.points[0], s.points[1]);
      if (len < 3 / z()) { requestFrame(); return; }
      if (s.tool === 'measure' && st.setScale) {
        const ans = await ui.promptDialog(`How long is that line in real life? (e.g. ${units() === 'imperial' ? `12' 6"` : '3.8 m or 3800 mm'})`, { title: 'Set drawing scale', okLabel: 'Set scale' });
        st.setScale = false;
        let m = ans == null ? null : parseLength(ans, { units: units(), bare: units() === 'imperial' ? 'ft' : 'm' });
        if (m != null && units() === 'metric' && /^\s*\d+(\.\d+)?\s*$/.test(ans) && m > 30) m /= 1000;
        if (m > 0) {
          checkpoint(); d.scale = len / (m / M_PER_FT); d.scaleSet = true; changed();
          ui.toast(`Scale set: ${fmtLength(m, { units: units(), denom: 4 })} = ${Math.round(len)} canvas units`, 'success');
          offerScaleToSet();
        }
        else { if (ans != null) ui.toast('Could not read that length', 'error'); updateChrome(); requestFrame(); }
        return;
      }
      checkpoint(); d.strokes.push(s); changed();
    } else if (cur.type === 'box') {
      const x0 = Math.min(cur.a[0], cur.b[0]), x1 = Math.max(cur.a[0], cur.b[0]), y0 = Math.min(cur.a[1], cur.b[1]), y1 = Math.max(cur.a[1], cur.b[1]);
      if (x1 - x0 > 2 / z() || y1 - y0 > 2 / z()) {
        const picked = [];
        const ok = (lid) => { const l = layerOf(lid); return l && usable(l); };
        const inside = (b) => b.x0 < x1 && b.x1 > x0 && b.y0 < y1 && b.y1 > y0;
        for (const [kind, arr] of [['stroke', d.strokes], ['object', d.objects], ['text', d.texts]]) {
          for (const it of arr) if (ok(it.layer) && inside(itemBounds(kind, it)) && !st.selection.some((s) => s.id === it.id)) picked.push({ kind, id: it.id });
        }
        const within = (b) => b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1;
        for (const r of d.rooms) if (ok(r.layer) && within(itemBounds('room', r)) && !st.selection.some((s) => s.id === r.id)) picked.push({ kind: 'room', id: r.id });
        st.selection = [...st.selection, ...picked];
      }
      updateChrome();
    }
    requestFrame();
  }

  function startPinch(touches) {
    const [a, b] = touches;
    pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, c0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: { ...st.view } };
  }
  function movePinch() {
    const touches = [...pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const c = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const v0 = pinch.v0;
    const nz = Math.min(24, Math.max(0.05, v0.zoom * dist / pinch.d0));
    const wx = (pinch.c0[0] - v0.x) / v0.zoom, wy = (pinch.c0[1] - v0.y) / v0.zoom;
    st.view = { zoom: nz, x: c[0] - wx * nz, y: c[1] - wy * nz };
    viewChanged();
  }

  function onWheel(e) {
    e.preventDefault();
    const [sx, sy] = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey ? 4 : 1)));
    else { st.view.x -= e.deltaX; st.view.y -= e.deltaY; viewChanged(); }
  }

  function onLeave() { st.hover = null; requestFrame(); }

  // Safari pinch on trackpads. On an iPad, Safari also sends these for any two touches, the
  // Pencil plus a resting palm included: pointers handle touch there, so with anything on the
  // glass they only get their default (zoom) cancelled.
  let gestureZ = 1;
  const touching = () => pointers.size > 0 || palms.size > 0;
  const onGestureStart = (e) => { e.preventDefault(); gestureZ = 1; };
  const onGestureChange = (e) => {
    e.preventDefault();
    if (touching()) { gestureZ = e.scale; return; }
    const [sx, sy] = local(e); zoomAt(sx, sy, e.scale / gestureZ); gestureZ = e.scale;
  };
  // iPadOS Scribble and the system's swipe gestures can claim a fast Pencil stroke and cancel
  // it; refusing the touches' default action keeps the stroke on the canvas. Pointer events
  // still arrive (Excalidraw and tldraw do the same).
  const noTouchDefault = (e) => { if (e.cancelable) e.preventDefault(); };

  // ---------- keyboard ----------
  function onKey(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('.sheet, .dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.type === 'keydown' && !mod && rooms.key(e)) { e.preventDefault(); return; }
    if (e.type === 'keyup') { if (e.code === 'Space') { st.space = false; wrap.classList.remove('space'); } return; }
    if (e.code === 'Space' && !mod) { st.space = true; wrap.classList.add('space'); e.preventDefault(); return; }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
    if (mod && k === 's') { e.preventDefault(); save(); ui.toast('Saved', 'success'); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { if (st.selection.length) { e.preventDefault(); deleteSel(); } return; }
    if (k === 'escape') { if (op?.type === 'wire') { op = null; st.snap = null; } st.placing = null; st.setScale = false; st.selection = []; pop.hidden = true; updateChrome(); requestFrame(); return; }
    if (k === 'enter') { finishWire(); return; }
    if (k === 'pageup' || k === 'pagedown') { e.preventDefault(); goSheet(k === 'pageup' ? -1 : 1); return; }
    if (k === '0') { fit(); return; }
    if (k === '=' || k === '+') { zoomBy(1.25); return; }
    if (k === '-') { zoomBy(0.8); return; }
    if (k === 's') { symbolsSheet(); return; }
    const t = ALL_TOOLS.find((x) => x.key === k);
    if (t) setTool(t.id);
  }

  // ---------- selection actions ----------
  function selectAll() {
    setTool('select');
    const ok = (lid) => { const l = layerOf(lid); return l && usable(l); };
    st.selection = [
      ...d.strokes.filter((s) => ok(s.layer)).map((s) => ({ kind: 'stroke', id: s.id })),
      ...d.objects.filter((s) => ok(s.layer)).map((s) => ({ kind: 'object', id: s.id })),
      ...d.texts.filter((s) => ok(s.layer)).map((s) => ({ kind: 'text', id: s.id })),
      ...d.rooms.filter((s) => ok(s.layer)).map((s) => ({ kind: 'room', id: s.id })),
    ];
    updateChrome(); requestFrame();
  }
  function deleteSel() {
    if (!st.selection.length) return;
    checkpoint();
    const gone = new Set(st.selection.map((s) => s.id));
    d.strokes = d.strokes.filter((s) => !gone.has(s.id));
    d.objects = d.objects.filter((s) => !gone.has(s.id));
    d.texts = d.texts.filter((s) => !gone.has(s.id));
    d.rooms = d.rooms.filter((s) => !gone.has(s.id));
    st.selection = [];
    changed();
  }
  function duplicateSel() {
    if (!st.selection.length) return;
    checkpoint();
    const off = 24;
    const next = [];
    for (const s of st.selection) {
      const it = findSel(s);
      if (!it) continue;
      const c = JSON.parse(JSON.stringify(it));
      c.id = uid();
      if (s.kind === 'stroke') c.points = c.points.map((p) => [p[0] + off, p[1] + off, p[2]]);
      else if (s.kind === 'room') { moveRoom(c, off, off); c.name = `${c.name} copy`; }
      else { c.x += off; c.y += off; }
      COLL[s.kind]().push(c);
      next.push({ kind: s.kind, id: c.id });
    }
    st.selection = next;
    changed();
  }
  function rotateSel() {
    const objs = st.selection.filter((s) => s.kind === 'object').map(findSel).filter(Boolean);
    if (!objs.length) return;
    checkpoint();
    for (const o of objs) o.rotation = ((o.rotation || 0) + 45) % 360;
    changed();
  }
  function scaleSel(f) {
    const items = st.selection.map((s) => ({ s, it: findSel(s) })).filter((x) => x.it && (x.s.kind === 'object' || x.s.kind === 'text'));
    if (!items.length) return;
    checkpoint();
    for (const { s, it } of items) {
      if (s.kind === 'object') it.scale = Math.min(6, Math.max(0.3, (it.scale || 1) * f));
      else it.size = Math.min(160, Math.max(6, Math.round((it.size || 18) * f)));
    }
    changed();
  }
  function recolorSel(color) {
    checkpoint();
    for (const s of st.selection) { const it = findSel(s); if (it) it.color = color; }
    changed();
  }
  function moveSelToLayer() {
    checkpoint();
    for (const s of st.selection) { const it = findSel(s); if (it) it.layer = st.activeLayer; }
    changed();
    ui.toast(`Moved to ${layerOf(st.activeLayer).name}`);
  }

  // ---------- chrome ----------
  function updateZoom() { zoomLabel.textContent = `${Math.round(z() * 100)}%`; renderSizeBar(); }

  let sizeBarKey = '';
  function renderSizeBar() {
    const t = st.tool, o = opts[t];
    const has = !st.placing && !!TOOL_SIZES[t] && !!o;
    sizeBar.hidden = !has;
    if (!has) return;
    const key = `${t}|${o.size}|${o.color}|${o.opacity}|${z()}`;
    if (key === sizeBarKey) return;
    sizeBarKey = key;
    ui.clear(sizeDotBtn).append(h('span', { class: 'cv-sizebar-well' }, sizeDot(t, o, 26)), h('span', { class: 'cv-sizebar-num' }, fmtSize(o.size)));
    sizeBar.dataset.size = String(o.size);
    sizeUp.disabled = o.size >= TOOL_SIZES[t][1];
    sizeDown.disabled = o.size <= TOOL_SIZES[t][0];
  }
  /** One step bigger or smaller: a quarter each time, so small and big brushes step alike. */
  function stepSize(dir) {
    const t = st.tool, o = opts[t];
    if (!o || !TOOL_SIZES[t]) return;
    let v = clampSize(t, dir > 0 ? o.size * 1.25 : o.size / 1.25);
    if (v === o.size) v = clampSize(t, o.size + dir * (o.size < 2 ? 0.1 : o.size < 10 ? 0.5 : 1));
    setSize(t, v);
    if (!pop.hidden) togglePop(true);
  }

  function updateChrome() {
    titleBtn.textContent = d.name || 'Untitled';
    undoBtn.disabled = !undo.length && op?.type !== 'wire';
    redoBtn.disabled = !redo.length;
    for (const [tid, b] of toolButtons) b.setAttribute('aria-pressed', String(tid === st.tool && !st.placing));
    wrap.dataset.tool = st.placing ? 'place' : st.tool;
    paperBtn.title = `Paper: ${PAPERS.find((p) => p.id === d.paper)?.label}`;
    // wheel centre
    const o = curOpts();
    const isEraser = st.tool === 'eraser';
    const sizePx = Math.max(6, Math.min(30, TOOL_SIZES[st.tool] ? screenSize(st.tool, o.size) : (o.size || 4) * 1.4));
    centerDot.style.width = centerDot.style.height = sizePx + 'px';
    centerDot.style.background = isEraser ? 'transparent' : (o.color || '#1c1b19');
    centerDot.classList.toggle('eraser', isEraser);
    centerRing.style.setProperty('--op', String(Math.round((o.opacity ?? 1) * 100)));
    centerLabel.textContent = st.placing ? 'Place' : (ALL_TOOLS.find((t) => t.id === st.tool)?.label || '');
    renderCtx();
    updateZoom();
  }

  function renderCtx() {
    ui.clear(ctxBar);
    const parts = [];
    const tbtn = (ic, label, fn, pressed) => h('button', { class: 'cv-btn', type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed == null ? null : String(pressed), onClick: fn }, icon(ic, 18));
    const roomParts = st.placing ? null : rooms.ctxParts();
    if (roomParts) {
      parts.push(...roomParts);
      if (st.selection.length === 1 && st.selection[0].kind === 'room' && !rooms.ghosts.length) parts.push(tbtn('copy', 'Duplicate (Ctrl+D)', duplicateSel), tbtn('trash', 'Delete room', deleteSel));
    } else if (st.placing) {
      parts.push(symbolPreview(st.placing, isDark() ? '#ecebe7' : '#1c1b19', 28), h('span', { class: 'cv-ctx-label' }, `${SYMBOLS[st.placing].label}: tap to place`),
        tbtn(RAW.rotate, 'Rotate 90°', () => { st.placeRot = (st.placeRot + 90) % 360; requestFrame(); }),
        h('button', { class: 'cv-chip', type: 'button', onClick: () => symbolsSheet() }, 'Change'),
        h('button', { class: 'cv-chip on', type: 'button', onClick: () => { st.placing = null; updateChrome(); requestFrame(); } }, 'Done'));
    } else if (st.tool === 'wire') {
      parts.push(h('span', { class: 'cv-ctx-label' }, op?.type === 'wire' ? `Wire: ${op.points.length} point${op.points.length === 1 ? '' : 's'}${d.scale ? ' · ' + fmtWorldLength(wireLength(op.points), d, units()) : ''}` : 'Wire: tap points, tap twice to finish'),
        tbtn(RAW.dash, 'Dashed (low voltage)', () => { st.wireDash = !st.wireDash; if (op?.type === 'wire') op.proto.dash = st.wireDash; renderCtx(); requestFrame(); }, st.wireDash),
        tbtn(RAW.curve, 'Curved runs', () => { st.wireCurve = !st.wireCurve; if (op?.type === 'wire') op.proto.curve = st.wireCurve; renderCtx(); requestFrame(); }, st.wireCurve));
      if (op?.type === 'wire') parts.push(h('button', { class: 'cv-chip', type: 'button', onClick: () => { op = null; st.snap = null; updateChrome(); requestFrame(); } }, 'Cancel'),
        h('button', { class: 'cv-chip on', type: 'button', onClick: () => finishWire() }, 'Finish'));
    } else if (st.tool === 'measure') {
      parts.push(h('span', { class: 'cv-ctx-label' }, st.setScale ? 'Drag along a length you know' : `Scale: ${units() === 'imperial' ? `1 ft = ${d.scale.toFixed(1)}` : `1 m = ${(d.scale / M_PER_FT).toFixed(1)}`} units`),
        h('button', { class: ['cv-chip', st.setScale ? 'on' : null], type: 'button', onClick: () => { st.setScale = !st.setScale; renderCtx(); } }, st.setScale ? 'Cancel' : 'Set scale'));
    } else if (st.selection.length) {
      const hasObj = st.selection.some((s) => s.kind === 'object');
      const hasSized = st.selection.some((s) => s.kind === 'object' || s.kind === 'text');
      const selObjs = st.selection.filter((s) => s.kind === 'object').map(findSel).filter(Boolean);
      parts.push(h('span', { class: 'cv-ctx-label' }, `${st.selection.length} selected`),
        st.selection.length === 1 ? collab.selectionInfo(findSel(st.selection[0])) : null,
        tbtn('copy', 'Duplicate (Ctrl+D)', duplicateSel),
        hasObj ? tbtn(RAW.rotate, 'Rotate 45°', rotateSel) : null,
        hasObj ? tbtn(RAW.tag, 'Protection and height (GFCI, AFCI, TR)', () => rooms.deviceSheet(selObjs)) : null,
        hasSized ? tbtn(RAW.bigger, 'Bigger', () => scaleSel(1.2)) : null,
        hasSized ? tbtn(RAW.smaller, 'Smaller', () => scaleSel(1 / 1.2)) : null,
        tbtn('palette', 'Apply current colour', () => recolorSel(lastColor)),
        tbtn('layers', 'Move to active layer', moveSelToLayer),
        tbtn('trash', 'Delete (Del)', deleteSel));
    }
    ctxBar.hidden = !parts.length;
    for (const p of parts) if (p) ctxBar.append(p);
  }

  let lastColor = opts.pen.color;
  /** How wide a tool's size is on screen right now, in CSS px (the eraser's size already is). */
  const screenSize = (t, size) => (t === 'eraser' ? size : size * z());
  const fmtSize = (v) => (v < 10 ? String(v) : String(Math.round(v)));

  /** Change a tool's size (clamped to its range), remember it, and refresh what shows it. */
  function setSize(t, v) {
    const o = opts[t];
    if (!o || !TOOL_SIZES[t]) return;
    o.size = clampSize(t, v);
    saveOpts(opts, OPTS_KEY);
    updateChrome();
    requestFrame();
  }

  /** A dot the size of the brush at the current zoom (capped so it fits). */
  function sizeDot(t, o, max = 44) {
    const px = screenSize(t, o.size);
    const shown = Math.max(2, Math.min(max, px));
    const dot = h('span', { class: ['cv-size-dot', t === 'eraser' ? 'eraser' : null, px > max ? 'clipped' : null],
      style: { width: shown + 'px', height: shown + 'px', background: t === 'eraser' ? 'transparent' : (o.color || '#1c1b19'), opacity: String(o.opacity ?? 1) } });
    return dot;
  }

  // the smoothness preview: the same shaky line, run through the stabilizer at this setting
  const SQUIGGLE = (() => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    const out = [];
    for (let i = 0; i <= 200; i++) {
      const x = 10 + i * 1.12;
      // a wave with one sharp V in the middle, plus a hand's tremor
      const y = 26 + 12 * Math.sin(i / 14) + Math.max(0, 10 - Math.abs(i - 100)) * 1.6;
      out.push([x + rnd() * 2.4, y + rnd() * 2.4, i * (1000 / 240)]);
    }
    return out;
  })();
  function drawSquiggle(c, t, o) {
    const dprr = Math.min(globalThis.devicePixelRatio || 1, 3);
    const w = 236, hh = 60;
    c.width = Math.round(w * dprr); c.height = Math.round(hh * dprr);
    const x = c.getContext('2d');
    x.setTransform(dprr, 0, 0, dprr, 0, 0);
    x.clearRect(0, 0, w, hh);
    const dark = isDark();
    // the raw samples, faint, under the smoothed line
    x.strokeStyle = dark ? 'rgba(236,235,231,.25)' : 'rgba(28,27,25,.18)'; x.lineWidth = 1;
    x.beginPath(); SQUIGGLE.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.stroke();
    const stab = createStabilizer({ smoothness: o.smooth ?? 0, zoom: 1, minDist: 0.8 });
    for (const [px, py, tt] of SQUIGGLE) stab.add([px, py, 0.6], tt);
    stab.end();
    drawStroke(x, { tool: t, color: o.color, size: Math.min(6, Math.max(1.5, o.size)), opacity: o.opacity ?? 1, points: stab.points }, d, { dark });
  }

  function togglePop(force) {
    if (force == null && wrap.classList.contains('wheel-min')) { wrap.classList.remove('wheel-min'); return; } // a tucked-away wheel opens first
    const show = force ?? pop.hidden;
    pop.hidden = !show;
    if (!show) return;
    ui.clear(pop);
    const t = st.tool;
    if (t === 'select' || t === 'hand') {
      // no brush here: just the colour used by "Apply current colour" and the next pen
      const pick = (c) => { lastColor = c; opts.pen.color = c; saveOpts(opts, OPTS_KEY); if (st.selection.length) recolorSel(c); updateChrome(); togglePop(true); };
      pop.append(h('div', { class: 'cv-pop-title' }, st.selection.length ? 'Colour selection' : 'Colour'),
        h('div', { class: 'cv-swatches', role: 'group', 'aria-label': 'Colours' },
          SWATCHES.map((s) => h('button', { type: 'button', class: ['cv-swatch', s.c === lastColor ? 'on' : null], title: s.n, 'aria-label': s.n, style: { background: s.c }, onClick: () => pick(s.c) }))));
      return;
    }
    const o = opts[t] || opts.pen;
    const isEraser = t === 'eraser';
    const tName = ALL_TOOLS.find((x) => x.id === t)?.label || 'Brush';
    const rows = [h('div', { class: 'cv-pop-title' }, `${tName} settings`)];
    let squiggle = null;
    if (TOOL_SIZES[t]) {
      const [lo, hi] = TOOL_SIZES[t];
      const sizeOut = h('output', { class: 'cv-size-out' }, fmtSize(o.size));
      const dotHost = h('span', { class: 'cv-size-preview', title: isEraser ? 'Eraser size on screen' : `At ${Math.round(z() * 100)}% zoom` }, sizeDot(t, o));
      const slider = h('input', { type: 'range', min: 0, max: SLIDER_STEPS, step: 1, value: sizeToSlider(t, o.size), 'aria-label': `${tName} size`, name: 'size',
        'aria-valuetext': `${fmtSize(o.size)}${isEraser ? ' px' : ''}`, dataset: { min: lo, max: hi },
        onInput: (e) => {
          setSize(t, sliderToSize(t, Number(e.target.value)));
          sizeOut.textContent = fmtSize(o.size);
          e.target.setAttribute('aria-valuetext', `${fmtSize(o.size)}${isEraser ? ' px' : ''}`);
          ui.clear(dotHost).append(sizeDot(t, o));
          if (squiggle) drawSquiggle(squiggle, t, o);
        } });
      rows.push(h('div', { class: 'cv-size-row' }, h('label', { class: 'cv-range' }, h('span', null, 'Size'), slider, sizeOut), dotHost));
    }
    if (isEraser) {
      const modeRow = h('div', { class: 'cv-seg', role: 'radiogroup', 'aria-label': 'Eraser mode' },
        [['area', 'Area'], ['stroke', 'Whole stroke']].map(([id, label]) => h('button', { type: 'button', role: 'radio', class: 'cv-chip' + ((o.mode || 'area') === id ? ' on' : ''), 'aria-checked': String((o.mode || 'area') === id), dataset: { mode: id },
          onClick: () => { o.mode = id; saveOpts(opts, OPTS_KEY); togglePop(true); } }, label)));
      rows.push(h('div', { class: 'cv-pop-sub' }, h('span', null, 'Erase'), modeRow),
        h('div', { class: 'cv-pop-hint' }, (o.mode || 'area') === 'area' ? 'Rubs out only what the circle touches.' : 'Removes each line it touches, whole.'));
    }
    if (FREEHAND.has(t)) {
      const smOut = h('output', null, String(clampSmooth(o.smooth)));
      squiggle = h('canvas', { class: 'cv-squiggle', role: 'img', 'aria-label': 'Preview of a shaky line at this smoothness' });
      rows.push(h('label', { class: 'cv-range' }, h('span', null, 'Smoothness'),
        h('input', { type: 'range', min: 0, max: 100, step: 1, value: clampSmooth(o.smooth), 'aria-label': `${tName} smoothness`, name: 'smooth',
          onInput: (e) => { o.smooth = clampSmooth(e.target.value); smOut.textContent = String(o.smooth); saveOpts(opts, OPTS_KEY); drawSquiggle(squiggle, t, o); } }), smOut),
      squiggle);
    }
    if (!isEraser && o.opacity != null && t !== 'measure') {
      const opOut = h('output', null, Math.round(o.opacity * 100) + '%');
      rows.push(h('label', { class: 'cv-range' }, h('span', null, 'Opacity'),
        h('input', { type: 'range', min: 10, max: 100, step: 5, value: Math.round(o.opacity * 100), 'aria-label': 'Opacity',
          onInput: (e) => { o.opacity = Number(e.target.value) / 100; opOut.textContent = e.target.value + '%'; saveOpts(opts, OPTS_KEY); updateChrome(); } }), opOut));
    }
    if (!isEraser) {
      const pick = (c) => { o.color = c; lastColor = c; saveOpts(opts, OPTS_KEY); updateChrome(); togglePop(true); };
      rows.push(h('div', { class: 'cv-swatches', role: 'group', 'aria-label': 'Colours (wire colours included)' },
        SWATCHES.map((s) => h('button', { type: 'button', class: ['cv-swatch', s.c.toLowerCase() === String(o.color).toLowerCase() ? 'on' : null], title: s.n, 'aria-label': s.n, style: { background: s.c }, onClick: () => pick(s.c) })),
        h('label', { class: 'cv-swatch custom', title: 'Custom colour' }, h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#1c1b19', 'aria-label': 'Custom colour', onChange: (e) => pick(e.target.value) }))));
    }
    rows.push(h('button', { type: 'button', class: 'cv-pop-link', onClick: () => { pop.hidden = true; gesturesSheet(); } }, icon('sliders', 16), 'Finger gestures'));
    pop.append(...rows);
    if (squiggle) drawSquiggle(squiggle, t, o);
  }

  function gesturesSheet() {
    ui.openSheet({
      title: 'Finger gestures',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'What a tap with two or three fingers does on a drawing. Also in Settings → Drawing.'),
        gesturePanel(ui, (k, v) => savePref(session.me, k, v))),
    });
  }

  // ---------- sheets ----------
  function symbolsSheet() {
    const ink = isDark() ? '#ecebe7' : '#1c1b19';
    const items = store.list('items', (i) => i.symbol);
    const s = ui.openSheet({
      title: 'Symbols',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Pick a symbol, then tap the plan to place it. Keep tapping to place more. Symbols count toward the takeoff.'),
        h('div', { class: 'cv-symbol-grid' }, SYMBOL_ORDER.map((sid) => {
          const priced = items.find((i) => i.symbol === sid);
          return h('button', { type: 'button', class: ['cv-symbol', st.placing === sid ? 'on' : null], dataset: { symbol: sid },
            onClick: () => { if (st.tool === 'eraser' || st.tool === 'hand') st.tool = 'select'; st.placing = sid; st.selection = []; s.close(); updateChrome(); ui.toast(`Tap the plan to place: ${SYMBOLS[sid].label}`); } },
          symbolPreview(sid, ink, 48), h('span', null, SYMBOLS[sid].label), priced && seesMoney ? h('small', { class: 'muted' }, ui.fmtMoney(priced.priceCents)) : null);
        }))),
    });
  }

  function layersSheet() {
    const body = h('div', { class: 'stack' });
    const s = ui.openSheet({ title: 'Layers', body, actions: [ui.button('Add layer', { variant: 'primary', icon: 'plus', onClick: () => addLayer() })] });
    function addLayer() {
      checkpoint();
      const idx = d.layers.findIndex((l) => l.id === st.activeLayer);
      const l = { id: 'L' + uid().slice(0, 8), name: `Layer ${d.layers.length + 1}`, visible: true, locked: false, opacity: 1 };
      d.layers.splice(idx + 1, 0, l);
      st.activeLayer = l.id;
      changed(); draw();
    }
    function draw() {
      ui.clear(body);
      const list = h('div', { class: 'list cv-layers' });
      // top layer first, like every layers panel
      [...d.layers].reverse().forEach((l) => {
        const idx = d.layers.indexOf(l);
        const count = d.strokes.filter((x) => x.layer === l.id).length + d.objects.filter((x) => x.layer === l.id).length + d.texts.filter((x) => x.layer === l.id).length
          + d.rooms.filter((x) => x.layer === l.id).length;
        const active = l.id === st.activeLayer;
        list.append(h('div', { class: ['list-row', 'cv-layer', active ? 'active' : null] },
          h('button', { class: 'cv-btn', type: 'button', title: l.visible === false ? 'Show layer' : 'Hide layer', 'aria-label': `${l.visible === false ? 'Show' : 'Hide'} ${l.name}`, 'aria-pressed': String(l.visible !== false),
            onClick: () => { l.visible = l.visible === false; changed(); draw(); } }, icon(l.visible === false ? 'eye-off' : 'eye', 18)),
          h('button', { class: 'cv-btn', type: 'button', title: l.locked ? 'Unlock layer' : 'Lock layer', 'aria-label': `${l.locked ? 'Unlock' : 'Lock'} ${l.name}`, 'aria-pressed': String(!!l.locked),
            onClick: () => { l.locked = !l.locked; st.selection = st.selection.filter((x) => findSel(x)?.layer !== l.id); changed(); draw(); } }, icon(l.locked ? 'lock' : 'unlock', 18)),
          h('button', { class: 'cv-layer-name grow', type: 'button', title: 'Make active', onClick: () => { st.activeLayer = l.id; updateChrome(); draw(); } },
            h('span', { class: 'title' }, l.name), h('span', { class: 'meta' }, `${active ? 'Active · ' : ''}${count} item${count === 1 ? '' : 's'}`)),
          h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((l.opacity ?? 1) * 100), class: 'cv-layer-op', 'aria-label': `${l.name} opacity`,
            onInput: (e) => { l.opacity = Number(e.target.value) / 100; changed(); } }),
          h('button', { class: 'cv-btn', type: 'button', title: 'Move up', 'aria-label': `Move ${l.name} up`, disabled: idx === d.layers.length - 1,
            onClick: () => { checkpoint(); d.layers.splice(idx, 1); d.layers.splice(idx + 1, 0, l); changed(); draw(); } }, icon(RAW.arrowUp, 16)),
          h('button', { class: 'cv-btn', type: 'button', title: 'Move down', 'aria-label': `Move ${l.name} down`, disabled: idx === 0,
            onClick: () => { checkpoint(); d.layers.splice(idx, 1); d.layers.splice(idx - 1, 0, l); changed(); draw(); } }, icon(RAW.arrowDown, 16)),
          h('button', { class: 'cv-btn', type: 'button', title: 'Rename', 'aria-label': `Rename ${l.name}`,
            onClick: async () => { const n = await ui.promptDialog('Layer name', { title: 'Rename layer', value: l.name }); if (n && n.trim()) { l.name = n.trim(); changed(); draw(); } } }, icon('edit', 16)),
          h('button', { class: 'cv-btn danger', type: 'button', title: 'Delete layer', 'aria-label': `Delete ${l.name}`, disabled: d.layers.length === 1,
            onClick: async () => {
              if (count && !(await ui.confirmDialog(`Delete "${l.name}" and its ${count} item${count === 1 ? '' : 's'}? You can undo this.`, { okLabel: 'Delete layer' }))) return;
              checkpoint();
              d.layers = d.layers.filter((x) => x.id !== l.id);
              d.strokes = d.strokes.filter((x) => x.layer !== l.id); d.objects = d.objects.filter((x) => x.layer !== l.id); d.texts = d.texts.filter((x) => x.layer !== l.id);
              d.rooms = d.rooms.filter((x) => x.layer !== l.id);
              if (st.activeLayer === l.id) st.activeLayer = d.layers[d.layers.length - 1].id;
              st.selection = st.selection.filter((x) => findSel(x));
              changed(); draw();
            } }, icon('trash', 16))));
      });
      body.append(list);
      // underlay
      body.append(h('h2', { class: 'section', style: { margin: '8px 0 0' } }, 'Plan underlay'));
      if (d.underlay) {
        body.append(h('div', { class: 'card flat stack' },
          h('label', { class: 'cv-range' }, h('span', null, 'Opacity'),
            h('input', { type: 'range', min: 5, max: 100, step: 5, value: Math.round((d.underlayOpacity ?? 1) * 100), 'aria-label': 'Underlay opacity',
              onInput: (e) => { d.underlayOpacity = Number(e.target.value) / 100; changed(); } })),
          h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: !!d.underlayLocked, onChange: (e) => { d.underlayLocked = e.target.checked; changed(); } }),
            h('span', null, 'Lock underlay (when unlocked, drag it with the Select tool)')),
          h('div', { class: 'row' },
            ui.button('Replace', { size: 'sm', icon: 'upload', onClick: () => { s.close(); importUnderlay(); } }),
            ui.button('Remove', { size: 'sm', variant: 'ghost danger', icon: 'trash', onClick: () => { checkpoint(); d.underlay = null; d.underlayW = d.underlayH = 0; underImg = null; changed(); draw(); } }))));
      } else {
        body.append(h('div', { class: 'card flat row' }, h('span', { class: 'muted grow' }, 'Import a floor plan (image or PDF) to mark up on top of it.'),
          ui.button('Import plan', { size: 'sm', icon: 'upload', onClick: () => { s.close(); importUnderlay(); } })));
      }
    }
    draw();
  }

  function takeoffSheet() {
    flushSave();
    const counts = takeoff(d);
    const items = store.list('items', (i) => i.symbol);
    const ink = isDark() ? '#ecebe7' : '#1c1b19';
    const rows = SYMBOL_ORDER.filter((sid) => counts[sid]).map((sid) => ({ sid, n: counts[sid], item: items.find((i) => i.symbol === sid) }));
    const total = rows.reduce((a, r) => a + (r.item ? r.item.priceCents * r.n : 0), 0);
    const wires = d.strokes.filter((s) => s.tool === 'wire' && layerOf(s.layer)?.visible !== false);
    const wirePx = wires.reduce((a, s) => a + wireLength(s.points), 0);
    // a sheet of a plan set can also price the whole set (every sheet's symbols together)
    const sheets = setSheets();
    const setSymbols = sheets.reduce((a, x) => a + (x.objects || []).filter((o) => o.symbol).length, 0);
    const s = ui.openSheet({
      title: 'Takeoff',
      body: h('div', { class: 'stack' },
        rows.length ? ui.table({
          columns: [
            { key: 'sym', label: '', render: (r) => symbolPreview(r.sid, ink, 32) },
            { key: 'label', label: 'Symbol', render: (r) => h('div', null, h('div', null, SYMBOLS[r.sid].label), h('div', { class: 'muted', style: { fontSize: '12px' } }, r.item ? r.item.sku : 'Not in price book')) },
            { key: 'n', label: 'Count', align: 'right', render: (r) => String(r.n) },
            seesMoney ? { key: 'v', label: 'Value', align: 'right', render: (r) => r.item ? ui.fmtMoney(r.item.priceCents * r.n) : '—' } : null,
          ].filter(Boolean), rows,
        }) : ui.empty({ icon: RAW.outlet, title: 'No symbols yet', text: 'Place receptacles, switches and lights from the Symbols library to count them here.' }),
        wires.length ? h('p', { class: 'muted', style: { margin: 0 } }, `${wires.length} wire run${wires.length === 1 ? '' : 's'} drawn, about ${fmtWorldLength(wirePx, d, units())} at the drawing scale.`) : null,
        rows.length && seesMoney ? h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Price-book value'), h('strong', { class: 'num' }, ui.fmtMoney(total))) : null,
        sheets.length > 1 ? h('p', { class: 'muted', style: { margin: 0 } }, `This sheet only. The whole set (${sheets.length} sheets) has ${setSymbols} symbol${setSymbols === 1 ? '' : 's'}.`) : null),
      actions: [
        ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
        sheets.length > 1 && ctx.auth.can('estimates') ? ui.button(`Estimate whole set (${sheets.length})`, { icon: 'layers', disabled: !setSymbols, onClick: () => { s.close(); flushSave(); nav(`#/estimates/new?fromPlanSet=${encodeURIComponent(d.planSet.id)}`); } }) : null,
        ctx.auth.can('estimates') ? ui.button(sheets.length > 1 ? 'Estimate this sheet' : 'Create estimate', { variant: 'primary', icon: 'file-text', disabled: !rows.length, onClick: () => { s.close(); flushSave(); nav(`#/estimates/new?fromDrawing=${encodeURIComponent(id)}`); } }) : null,
        seesMoney && d.jobId ? ui.button('Cost impact', { icon: COLLAB_ICON, onClick: () => { s.close(); collab.open('cost'); } }) : null,
      ].filter(Boolean),
    });
  }

  function detailsSheet() {
    const jobs = store.list('jobs');
    ui.formSheet({
      title: 'Drawing details',
      fields: [
        { label: 'Name', name: 'name', value: d.name, required: true, span: true },
        { label: 'Job', name: 'jobId', type: 'select', value: d.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`), span: true },
        { label: 'Paper', name: 'paper', type: 'select', value: d.paper, options: PAPERS.map((p) => ({ value: p.id, label: p.label })) },
        { label: 'Scale (canvas units per foot)', name: 'scale', type: 'number', step: 'any', min: 0.1, value: Math.round(d.scale * 100) / 100, hint: `Or use Measure → Set scale on the plan. 1 m = ${(d.scale / M_PER_FT).toFixed(1)} units.` },
      ],
      onSubmit: (v) => {
        d.name = v.name.trim() || 'Untitled';
        d.jobId = v.jobId || null;
        const rescaled = v.scale > 0 && Math.abs(v.scale - Math.round(d.scale * 100) / 100) > 1e-9;
        if (v.paper !== d.paper || rescaled) { checkpoint(); d.paper = v.paper; if (rescaled) { d.scale = v.scale; d.scaleSet = true; } }
        changed();
        save();
        if (rescaled) offerScaleToSet();
      },
    });
  }

  function moreSheet() {
    const row = (ic, title, meta, fn) => h('div', { class: 'list-row click', tabindex: 0, role: 'button', onClick: () => { s.close(); fn(); }, onKeydown: (e) => { if (e.key === 'Enter') { s.close(); fn(); } } },
      icon(ic, 20), h('div', { class: 'grow' }, h('div', { class: 'title' }, title), meta ? h('div', { class: 'meta' }, meta) : null));
    const job = d.jobId && store.get('jobs', d.jobId);
    const s = ui.openSheet({
      title: d.name || 'Drawing',
      body: h('div', { class: 'stack' },
        h('div', null, h('div', { class: 'field' }, h('span', null, 'Paper')),
          ui.tabs(PAPERS.map((p) => ({ id: p.id, label: p.label })), d.paper, (pid) => { checkpoint(); d.paper = pid; changed(); s.close(); moreSheet(); })),
        h('div', { class: 'list' },
          row('edit', 'Details', `Rename, link to a job${job ? ` (now ${job.number})` : ''}, scale`, detailsSheet),
          row('ruler', 'Set scale', `${units() === 'imperial' ? `1 ft = ${d.scale.toFixed(1)}` : `1 m = ${(d.scale / M_PER_FT).toFixed(1)}`} units. Measure a known length on the plan.`, () => { setTool('measure'); st.setScale = true; updateChrome(); }),
          row(RAW.room, 'Draw a room', 'Walls, doors, windows and counters for auto-place and the code check', () => setTool('room')),
          row(RAW.wand, 'Auto-place boxes in every room', d.rooms.length ? `${d.rooms.length} room${d.rooms.length === 1 ? '' : 's'}: receptacles, switches, lights, alarms` : 'Draw a room first', () => rooms.autoPlace()),
          row(RAW.check, 'Code check', 'CEC 2024 receptacle rules, GFCI, AFCI, alarms', () => rooms.openCheck()),
          row(COLLAB_ICON, 'Changes', 'History by person and day, and who drew what', () => collab.open('history')),
          seesMoney ? row('dollar', 'Cost impact', d.jobId ? 'What the changes do to the estimate; create a change order' : 'Link to a job with an estimate first', () => collab.open('cost')) : null,
          row('sliders', 'Placement & check settings', 'Mounting heights, alarms, live check', () => rooms.settingsSheet()),
          row('pointer', 'Finger gestures', `Two-finger tap: ${actionLabel(getGesture('twoFingerTap'))} · three-finger tap: ${actionLabel(getGesture('threeFingerTap'))}`, gesturesSheet),
          row('upload', 'Import plan', 'Image or PDF. A PDF with several pages becomes a plan set, one drawing per sheet', importUnderlay),
          d.planSet?.id ? row('layers', 'Sheets in this set', `${d.planSet.name}: jump to any sheet`, sheetsSheet) : null,
          row('list', 'Takeoff', 'Count symbols and create an estimate', takeoffSheet),
          row('image', 'Export PNG', 'High-resolution image', exportPNG),
          row('download', 'Export SVG', 'Vector file for CAD and print', exportSVG),
          job ? row('briefcase', 'Open job', `${job.number} · ${job.title}`, () => { flushSave(); nav('#/jobs/' + job.id); }) : null,
          row('trash', d.planSet?.id ? 'Delete sheet or set' : 'Delete drawing', d.planSet?.id ? 'This sheet, or every sheet in the set' : 'Removes it from this device', deleteDrawing))),
    });
  }

  async function deleteDrawing() {
    flushSave();
    const sheets = setSheets();
    if (sheets.length > 1) {
      const pick = await chooseDialog(ui, {
        title: 'Delete from the plan set',
        message: `"${d.name}" is one of ${sheets.length} sheets in ${d.planSet.name}. Delete just this sheet, or every sheet in the set? This can't be undone.`,
        choices: [{ id: 'one', label: 'Delete this sheet', variant: 'danger' }, { id: 'all', label: `Delete all ${sheets.length} sheets`, variant: 'danger solid' }],
      });
      if (!pick) return;
      clearTimeout(saveTimer); saveTimer = 0;
      if (pick === 'all') {
        for (const x of sheets) store.remove('drawings', x.id);
        ui.toast(`Deleted ${sheets.length} sheets`);
        return nav('#/drawings' + (d.jobId ? '?jobId=' + d.jobId : ''));
      }
      const { prev, next } = neighbours(sheets, id);
      store.remove('drawings', id);
      ui.toast('Sheet deleted');
      return nav('#/drawings/' + (next || prev).id); // carry on in the set
    }
    if (!(await ui.confirmDialog(`Delete "${d.name}"? This can't be undone.`, { okLabel: 'Delete drawing' }))) return;
    clearTimeout(saveTimer); saveTimer = 0;
    store.remove('drawings', id);
    ui.toast('Drawing deleted');
    nav('#/drawings');
  }

  // ---------- plan sets ----------
  /** This drawing's set, sheets in page order, without their underlays. Empty when it isn't a sheet. */
  function setSheets() {
    const sid = d.planSet?.id;
    if (!sid) return [];
    const rows = store.list('drawings', (x) => x.planSet?.id === sid || x.id === id, { omit: SHEET_OMIT });
    // this drawing as it is now, which may be ahead of the store
    return sortSheets(rows.map((x) => (x.id === id ? { ...x, name: d.name, scale: d.scale, scaleSet: d.scaleSet, planSet: d.planSet, objects: d.objects } : x)));
  }

  function renderSheetBar() {
    const sheets = setSheets();
    const nb = neighbours(sheets, id);
    sheetBar.hidden = sheets.length < 2 || nb.index < 0;
    if (sheetBar.hidden) return;
    sheetPrev.disabled = !nb.prev;
    sheetNext.disabled = !nb.next;
    ui.clear(sheetLabelBtn).append(h('strong', null, sheetLabel(d.planSet)), h('span', { class: 'cv-sheet-pos' }, `${nb.index + 1}/${nb.count}`), icon('chevron-down', 16));
    sheetLabelBtn.title = 'All sheets in this set';
    sheetLabelBtn.setAttribute('aria-label', `Sheet ${sheetLabel(d.planSet)}, ${nb.index + 1} of ${nb.count}. Show all sheets`);
  }

  function goSheet(step) {
    const sheets = setSheets();
    if (sheets.length < 2) return;
    const nb = neighbours(sheets, id);
    const to = step < 0 ? nb.prev : nb.next;
    if (to) openSheetId(to.id);
  }
  function openSheetId(sid) {
    if (sid === id) return;
    flushSave();
    nav('#/drawings/' + sid);
  }

  function sheetsSheet() {
    const sheets = setSheets();
    if (!sheets.length) return;
    const symbolsOf = (x) => (x.objects || []).filter((o) => o.symbol).length;
    const addSheet = () => {
      flushSave();
      const page = Math.max(...sheets.map((x) => x.planSet?.page || 1)) + 1;
      const rec = store.add('drawings', customerSheetRecord({ setId: d.planSet.id, name: d.planSet.name, clientId: d.clientId || null, jobId: d.jobId || null, page, layers: d.layers }));
      s.close();
      nav('#/drawings/' + rec.id);
    };
    const s = ui.openSheet({
      title: d.planSet.name,
      actions: d.planSet.customer ? [ui.button('Add a sheet', { variant: 'primary', icon: 'plus', onClick: addSheet })] : [],
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}. Each sheet keeps its own scale and markup.`),
        h('div', { class: 'list cv-sheet-list' }, sheets.map((x) => {
          const here = x.id === id;
          const n = symbolsOf(x);
          return h('button', { class: ['list-row', 'click', 'cv-sheet-row', here ? 'on' : null], type: 'button', 'aria-current': here ? 'page' : null, onClick: () => { s.close(); openSheetId(x.id); } },
            h('span', { class: 'cv-sheet-thumb' }, x.thumb ? h('img', { src: x.thumb, alt: '', loading: 'lazy' }) : icon('image', 20)),
            h('span', { class: 'grow cv-sheet-text' },
              h('span', { class: 'title' }, sheetLabel(x.planSet)),
              h('span', { class: 'meta' }, [x.planSet?.label ? `Page ${x.planSet.page}` : null, hasOwnScale(x) ? 'Scale set' : 'No scale yet', n ? `${n} symbol${n === 1 ? '' : 's'}` : null, here ? 'Open now' : null].filter(Boolean).join(' · '))),
            here ? null : icon('chevron-right', 18));
        }))),
    });
  }

  /** After a sheet's scale changes: offer it to the set's other sheets (unscaled ones, or all). */
  async function offerScaleToSet() {
    flushSave(); // this sheet's new scale goes to the store before the others take it
    const sheets = setSheets();
    if (sheets.length < 2) return;
    const me = sheets.find((x) => x.id === id);
    const others = sheets.length - 1;
    const unscaled = scaleTargets(sheets, me, 'unscaled');
    const all = scaleTargets(sheets, me, 'all');
    const choices = [];
    if (unscaled.length) choices.push({ id: 'unscaled', label: unscaled.length === others ? `Use on all ${others}` : `Only the ${unscaled.length} with no scale`, variant: 'primary' });
    if (unscaled.length < others) choices.push({ id: 'all', label: `All ${others}, replacing theirs`, variant: unscaled.length ? 'secondary' : 'primary' });
    const scaled = others - unscaled.length;
    const pick = await chooseDialog(ui, {
      title: 'Same scale on the other sheets?',
      message: `Use this scale on the other ${others} sheet${others === 1 ? '' : 's'} in this set?${scaled ? ` ${scaled} already ha${scaled === 1 ? 's its' : 've their'} own scale.` : ''} Sheets drawn at a different scale (site plan, details) need their own.`,
      choices, cancelLabel: 'Not now',
    });
    if (!pick) return;
    const targets = pick === 'all' ? all : unscaled;
    for (const t of targets) store.update('drawings', t.id, { scale: t.scale, scaleSet: true }, { summary: `Scale copied from ${d.name}`.slice(0, 80) });
    ui.toast(`Scale set on ${targets.length} more sheet${targets.length === 1 ? '' : 's'}`, 'success');
  }

  function cyclePaper() {
    const i = PAPERS.findIndex((p) => p.id === d.paper);
    const next = PAPERS[(i + 1) % PAPERS.length];
    checkpoint(); d.paper = next.id; changed();
    ui.toast(`Paper: ${next.label}`);
  }

  /** Put a rendered page or image under this drawing (undoable). */
  function setUnderlay(out, planSet) {
    checkpoint();
    d.underlay = out.url;
    d.underlayW = out.w; d.underlayH = out.h;
    d.underlayX = 0; d.underlayY = 0;
    d.underlayLocked = true;
    d.underlayOpacity = d.underlayOpacity ?? 1;
    if (planSet !== undefined) d.planSet = planSet;
    loadUnderlay();
    changed();
    underImg.addEventListener('load', () => fit(), { once: true });
  }

  /**
   * Import a plan: an image, one PDF page, or several PDF pages as a plan set. With a set,
   * this drawing gets the first page and every other page becomes a new drawing that copies
   * this one's job, paper and layers.
   * @param {File} [given] a file instead of the picker (tests)
   */
  async function importUnderlay(given) {
    const file = given instanceof Blob ? given : await ui.pickFile('image/*,application/pdf');
    if (!file) return;
    if (!isPdf(file)) {
      if (!file.type.startsWith('image/')) { ui.toast('Pick an image or a PDF', 'error'); return; }
      try {
        setUnderlay(await renderImage(file));
        ui.toast('Plan imported. Set the scale with Measure → Set scale.', 'success', 4000);
      } catch (err) {
        ui.toast(err?.message || 'Could not import that file', 'error', 4000);
      }
      return;
    }
    let doc = null;
    try {
      ui.toast('Reading PDF…', 'info', 1400);
      doc = await openPdf(file);
      const pages = doc.numPages > 1 ? await pickPages(ui, doc, { title: `Import sheets · ${doc.name}` }) : [1];
      if (!pages?.length || destroyed) return;
      if (pages.length === 1) {
        const out = await renderSheet(doc, pages[0]);
        if (destroyed) return;
        // a sheet of a set keeps its place; only the render size can change
        setUnderlay(out, d.planSet?.id ? makePlanSet({ ...d.planSet, pxPerPt: out.pxPerPt }) : undefined);
        ui.toast('Plan imported. Set the scale with Measure → Set scale.', 'success', 4000);
        return;
      }
      await importSet(doc, pages);
    } catch (err) {
      ui.toast(err?.message || 'Could not import that file', 'error', 4000);
    } finally {
      doc?.close();
    }
  }

  async function importSet(doc, pages) {
    flushSave();
    // a customer's set keeps its id and name: the PDF's pages become more sheets of it
    const cust = d.planSet?.customer ? d.planSet : null;
    const setId = cust ? cust.id : uid();
    const base = { jobId: d.jobId, paper: d.paper, layers: d.layers, clientId: d.clientId || null };
    let next = cust ? Math.max(cust.page, ...setSheets().map((x) => x.planSet?.page || 1)) : 0;
    let first = true;
    const res = await importPages(ui, doc, pages, async (r) => {
      const ps = cust
        ? makePlanSet({ id: setId, name: cust.name, page: first ? cust.page : ++next, label: r.label || `Sheet ${first ? cust.page : next}`, pageCount: null, pxPerPt: r.pxPerPt, customer: true })
        : makePlanSet({ id: setId, name: doc.name, page: r.page, label: r.label, pageCount: doc.numPages, pxPerPt: r.pxPerPt });
      if (first && !destroyed && store.count('drawings', (x) => x.id === id)) {
        first = false;
        if (isDefaultDrawingName(d.name)) d.name = sheetName(ps.name, ps.label, ps.page);
        setUnderlay(r, ps);
        save(); // in the store now, so the set is whole even if the import stops here
      } else {
        store.add('drawings', sheetRecord(base, ps, r));
      }
    });
    if (destroyed) return;
    renderSheetBar();
    updateChrome();
    const n = res.done.length;
    if (n && !res.failed.length && !res.cancelled) {
      ui.toast(n === 1 ? 'Plan imported. Set the scale with Measure → Set scale.' : `Imported ${n} sheets. This drawing is ${sheetLabel(d.planSet)}; use the sheet bar to move between them.`, 'success', 5000);
    }
  }

  const fileName = (ext) => `${(d.name || 'drawing').replace(/[^\w\- ]+/g, '').trim() || 'drawing'}.${ext}`;
  function exportPNG() {
    const c = renderToCanvas(d, { underlayImage: underImg, scale: 2, maxW: 6000, maxH: 6000, units: units() });
    c.toBlob((blob) => {
      if (!blob) return ui.toast('Export failed', 'error');
      ui.download(fileName('png'), blob, 'image/png');
      store.log('export', `Exported ${d.name} as PNG`, 'drawings', id);
    }, 'image/png');
  }
  function exportSVG() {
    ui.download(fileName('svg'), toSVG(d, { units: units() }), 'image/svg+xml');
    store.log('export', `Exported ${d.name} as SVG`, 'drawings', id);
  }

  // ---------- wire up ----------
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  canvas.addEventListener('touchstart', noTouchDefault, { passive: false });
  canvas.addEventListener('touchmove', noTouchDefault, { passive: false });
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  const mo = new MutationObserver(() => { baseDirty = true; updateChrome(); requestFrame(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { baseDirty = true; requestFrame(); };
  mq.addEventListener?.('change', onScheme);
  const onHide = () => { if (document.visibilityState === 'hidden') flushSave(); };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', flushSave);

  rooms = createRooms({
    d, st, store, ui, auth: ctx.auth, wrap, z, checkpoint, changed, requestFrame, updateChrome, setTool, centerOn, label, isDark, layerOf, usable,
  });
  collab = createCollab({
    d, id, st, store, ui, auth: ctx.auth, nav, wrap, z, centerOn, requestFrame, isDark, layerOf, flushSave, size: () => ({ w: W, h: H }),
  });

  // Another device's copy of this drawing arrived (sync): merge it object by object, so both
  // people's work stays. Local edits are saved (stamped) first. Undo history is cleared when
  // the plan changed under it, so an undo can never delete someone else's work.
  const offRemote = store.on('drawings', (e) => {
    if (!e.remote || e.type !== 'update' || e.record?.id !== id || destroyed) return;
    const remote = store.get('drawings', id);
    const pendingLocal = Boolean(saveTimer);
    flushSave();
    const res = collab.mergeRemote(remote);
    if (res.changed) { undo = []; redo = []; st.selection = st.selection.filter((x) => findSel(x)); if (!layerOf(st.activeLayer)) st.activeLayer = d.layers[d.layers.length - 1].id; }
    if (res.dirty || pendingLocal) { contentDirty = true; scheduleSave(); }
    baseDirty = true;
    updateChrome(); renderSheetBar(); requestFrame();
  });

  loadUnderlay();
  resize();
  updateChrome();
  renderSheetBar();
  // #/drawings/<id>?focus=<history entry>: open the history and zoom to that change
  if (ctx.query?.focus) { collab.open('history'); collab.focusEntry(ctx.query.focus); }

  // exposed for tests
  globalThis.kelbeCanvas = {
    d, st, setTool, fit, takeoff: () => takeoff(d), save: () => save(), rooms, opts, undoDepth: () => undo.length, redoDepth: () => redo.length,
    importFile: (file) => importUnderlay(file), sheets: () => setSheets(), goSheet, collab,
  };

  return () => {
    destroyed = true;
    clearTimeout(holdTimer);
    flushSave();
    offRemote();
    collab.destroy();
    rooms.destroy();
    cancelAnimationFrame(rafId);
    ro.disconnect(); mo.disconnect();
    mq.removeEventListener?.('change', onScheme);
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    removeEventListener('pagehide', flushSave);
    document.removeEventListener('visibilitychange', onHide);
    document.body.classList.remove('canvas-open');
    root.classList.remove('full-bleed');
    // Flipping through a plan set opens a new editor per sheet: let go of this one's pixels now
    // (two screen-sized canvases and a decoded 4096 px plan) rather than whenever Safari collects.
    release(canvas); release(base);
    if (underImg) { underImg.src = ''; underImg = null; }
    if (globalThis.kelbeCanvas?.d === d) delete globalThis.kelbeCanvas;
  };
}
