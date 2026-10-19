// The canvas editor (S02–S10): infinite paper, pressure pens, tool wheel,
// layers, symbols, wires, measure, import/export and takeoff.
import { uid } from '../store.js';
import {
  drawPaper, drawContent, drawStroke, drawObject, hitTest, hitStroke, itemBounds, textBounds,
  contentBounds, renderToCanvas, toSVG, takeoff, fmtFeet, segLen, wireLength, FREEHAND,
} from './engine.js';
import { SYMBOLS, SYMBOL_ORDER, symbolPreview } from './symbols.js';

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
];
const ALL_TOOLS = [...WHEEL_TOOLS, ...SHAPE_TOOLS];

export const SWATCHES = [
  { c: '#1c1b19', n: 'Black / ink' }, { c: '#c62f2f', n: 'Red' }, { c: '#1f5fb8', n: 'Blue' }, { c: '#ffffff', n: 'White' },
  { c: '#1d7044', n: 'Green (ground)' }, { c: '#e07a1f', n: 'Orange' }, { c: '#7a4a24', n: 'Brown' }, { c: '#f5b301', n: 'Yellow' },
  { c: '#8a8478', n: 'Grey' }, { c: '#7a3fb0', n: 'Purple' }, { c: '#0e8a8a', n: 'Teal' }, { c: '#d6457a', n: 'Pink' },
];

const PAPERS = [{ id: 'none', label: 'Blank' }, { id: 'dots', label: 'Dots' }, { id: 'grid', label: 'Grid' }, { id: 'iso', label: 'Isometric' }];

const DEFAULT_OPTS = () => ({
  pen: { size: 3, opacity: 1, color: '#1c1b19' },
  pencil: { size: 2, opacity: 1, color: '#5f5a51' },
  marker: { size: 7, opacity: 0.9, color: '#1f5fb8' },
  highlighter: { size: 20, opacity: 1, color: '#f5b301' },
  eraser: { size: 18 },
  line: { size: 2.5, opacity: 1, color: '#1c1b19' },
  rect: { size: 2.5, opacity: 1, color: '#1c1b19' },
  wire: { size: 2.5, opacity: 1, color: '#c62f2f' },
  text: { size: 18, opacity: 1, color: '#1c1b19' },
  measure: { size: 1.5, opacity: 1, color: '#1c1b19' },
});

function loadOpts() {
  try { return { ...DEFAULT_OPTS(), ...JSON.parse(localStorage.getItem('kc.canvas.opts') || '{}') }; } catch { return DEFAULT_OPTS(); }
}
function saveOpts(o) { try { localStorage.setItem('kc.canvas.opts', JSON.stringify(o)); } catch { /* ignore */ } }

export function normalizeDrawing(d) {
  d.layers = d.layers?.length ? d.layers : [{ id: 'L1', name: 'Layer 1', visible: true, locked: false, opacity: 1 }];
  d.strokes ||= []; d.objects ||= []; d.texts ||= [];
  d.paper ||= 'grid';
  d.scale = Number(d.scale) > 0 ? Number(d.scale) : 24;
  if (d.underlayOpacity == null) d.underlayOpacity = 1;
  return d;
}

let pdfjsPromise = null;
function loadPdfJs() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
  pdfjsPromise ||= new Promise((resolve, reject) => {
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    const s = document.createElement('script');
    s.src = base + 'pdf.min.js';
    s.onload = () => {
      const lib = globalThis.pdfjsLib;
      if (!lib) { pdfjsPromise = null; s.remove(); return reject(new Error('Could not load the PDF reader. Check your connection, or import the plan as an image.')); }
      lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
      resolve(lib);
    };
    s.onerror = () => { pdfjsPromise = null; s.remove(); reject(new Error('Could not load the PDF reader. Check your connection, or import the plan as an image.')); };
    document.head.append(s);
  });
  return pdfjsPromise;
}

const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = src; });

/** Downscale anything to <= 4096 px on the long side, flattened on white. */
function flatten(source, w, h) {
  const k = Math.min(1, 4096 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(source, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
}

export function openEditor(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h, icon } = ui;
  const rec = store.get('drawings', id);
  if (!rec) {
    root.append(ui.page({ title: 'Drawing not found' }, ui.empty({ icon: 'pen', title: 'This drawing no longer exists', action: ui.button('Back to drawings', { href: '#/drawings' }) })));
    return;
  }
  const d = normalizeDrawing(rec);
  const opts = loadOpts();
  const st = {
    tool: 'pen', view: d.view && !(d.view.x === 0 && d.view.y === 0 && d.view.zoom === 1) ? { ...d.view } : null,
    activeLayer: d.layers[d.layers.length - 1].id, selection: [], placing: null, placeRot: 0,
    wireDash: false, wireCurve: false, setScale: false, penSeen: false, space: false, hover: null,
  };
  let undo = [], redo = [];
  let op = null;
  const pointers = new Map();
  let pinch = null;
  let underImg = null;
  let dpr = 1, W = 0, H = 0;
  let baseDirty = true, rafId = 0, saveTimer = 0, contentDirty = false, destroyed = false;

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
    btn('chevron-left', 'Back to drawings', () => { flushSave(); nav('#/drawings' + (d.jobId ? '?jobId=' + d.jobId : '')); }),
    titleBtn);
  const topRight = h('div', { class: 'cv-bar cv-top-right' },
    undoBtn, redoBtn, h('span', { class: 'cv-sep' }),
    btn(RAW.outlet, 'Symbols', () => symbolsSheet(), { class: 'wide-only' }),
    btn('layers', 'Layers', () => layersSheet()),
    paperBtn,
    btn('upload', 'Import plan (image or PDF)', () => importUnderlay(), { class: 'wide-only' }),
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

  const wrap = h('div', { class: 'cv' }, canvas, topLeft, topRight, ctxBar, shapes, wheel, pop, zoomBar);
  root.append(wrap);

  // ---------- helpers ----------
  const z = () => st.view.zoom;
  const toWorld = (sx, sy) => [(sx - st.view.x) / st.view.zoom, (sy - st.view.y) / st.view.zoom];
  const layerOf = (lid) => d.layers.find((l) => l.id === lid);
  const usable = (l) => l.visible !== false && !l.locked;
  const COLL = { stroke: () => d.strokes, object: () => d.objects, text: () => d.texts };
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
      json: JSON.stringify({ layers: d.layers, strokes: d.strokes, objects: d.objects, texts: d.texts, paper: d.paper, scale: d.scale,
        underlayX: d.underlayX, underlayY: d.underlayY, underlayW: d.underlayW, underlayH: d.underlayH, underlayOpacity: d.underlayOpacity, underlayLocked: d.underlayLocked }),
      underlay: d.underlay,
    };
  }
  function restore(s) {
    Object.assign(d, JSON.parse(s.json));
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
    if (content) { contentDirty = true; }
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
    if (!store.get('drawings', id)) return; // deleted
    const patch = {
      name: d.name, jobId: d.jobId || null, paper: d.paper, scale: d.scale, layers: d.layers, strokes: d.strokes, objects: d.objects, texts: d.texts,
      underlay: d.underlay || null, underlayX: d.underlayX || 0, underlayY: d.underlayY || 0, underlayW: d.underlayW || 0, underlayH: d.underlayH || 0,
      underlayOpacity: d.underlayOpacity, underlayLocked: !!d.underlayLocked, view: st.view ? { ...st.view } : null,
    };
    if (contentDirty) {
      contentDirty = false;
      try {
        const has = contentBounds(d);
        patch.thumb = has ? renderToCanvas(d, { fixed: { w: 360, h: 240 }, pad: 24, underlayImage: underImg }).toDataURL('image/jpeg', 0.72) : null;
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
    drawContent(bg, d, { zoom: v.zoom, dark: isDark(), underlayImage: underImg });
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
    if (op?.stroke) drawStroke(g, op.stroke, d, { zoom: v.zoom, dark });
    if (op?.type === 'wire') {
      const pts = op.hover ? [...op.points, op.hover] : op.points;
      if (pts.length > 1) drawStroke(g, { ...op.proto, points: pts }, d, { zoom: v.zoom, dark });
      g.globalAlpha = 1;
      if (op.hover && d.scale > 0) label(g, op.hover, fmtFeet(wireLength(pts) / d.scale));
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
    st.tool = t;
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

  function eraseAt(wx, wy) {
    const r = opts.eraser.size / 2 / z();
    const ok = (lid) => { const l = layerOf(lid); return l && usable(l); };
    const hitS = d.strokes.filter((s) => ok(s.layer) && hitStroke(s, wx, wy, r));
    const hitO = d.objects.filter((o) => ok(o.layer) && Math.hypot(o.x - wx, o.y - wy) <= 15 * (o.scale || 1) + r);
    const hitT = d.texts.filter((t) => { if (!ok(t.layer)) return false; const b = textBounds(t); return wx >= b.x0 - r && wx <= b.x1 + r && wy >= b.y0 - r && wy <= b.y1 + r; });
    if (!hitS.length && !hitO.length && !hitT.length) return;
    if (!op.cp) { checkpoint(); op.cp = true; }
    const gone = new Set([...hitS, ...hitO, ...hitT].map((x) => x.id));
    d.strokes = d.strokes.filter((s) => !gone.has(s.id));
    d.objects = d.objects.filter((o) => !gone.has(o.id));
    d.texts = d.texts.filter((t) => !gone.has(t.id));
    changed();
  }

  function translateSel(dx, dy) {
    for (const s of st.selection) {
      const it = findSel(s);
      if (!it) continue;
      if (s.kind === 'stroke') it.points = it.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]);
      else { it.x += dx; it.y += dy; }
    }
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
  async function editText(t) {
    const text = await ui.promptDialog('Label text', { title: 'Edit label', value: t.text, okLabel: 'Save' });
    if (text == null) return;
    checkpoint();
    if (!text.trim()) d.texts = d.texts.filter((x) => x.id !== t.id);
    else t.text = text.trim();
    changed();
  }

  // ---------- pointer input ----------
  function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  function onDown(e) {
    if (e.pointerType === 'pen') st.penSeen = true;
    pop.hidden = true;
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const touches = [...pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length >= 2) {
      // second finger: abandon any stroke in progress and start a pinch
      if (op?.type !== 'wire') op = null; // moves/erases already applied stay applied
      startPinch(touches);
      requestFrame();
      return;
    }
    if (pinch) return;
    const [wx, wy] = toWorld(sx, sy);
    const panTool = e.button === 1 || st.space || st.tool === 'hand' || (e.pointerType === 'touch' && st.penSeen);
    if (panTool) { op = { type: 'pan', sx, sy, vx: st.view.x, vy: st.view.y }; wrap.classList.add('panning'); return; }
    if (e.button === 2) return;

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
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      op = { type: 'draw', start: [wx, wy], stroke: { id: uid(), layer: st.activeLayer, tool: t, color: o.color, size: o.size, opacity: o.opacity, points: [[wx, wy, p]] } };
    } else if (t === 'line' || t === 'rect' || t === 'measure') {
      if (!st.setScale && !needLayer()) return;
      const o = opts[t];
      op = { type: 'shape', stroke: { id: uid(), layer: st.activeLayer, tool: t, color: o.color, size: o.size, opacity: o.opacity, points: [[wx, wy, 0.5], [wx, wy, 0.5]] } };
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
      const hit = hitTest(d, wx, wy, 4 / z(), usable);
      if (hit?.kind === 'text') editText(hit.item); else addText(wx, wy);
    } else if (t === 'eraser') {
      op = { type: 'erase', cp: false };
      eraseAt(wx, wy);
    } else if (t === 'select') {
      const hit = hitTest(d, wx, wy, 6 / z(), usable);
      if (hit) {
        const key = { kind: hit.kind, id: hit.item.id };
        const inSel = st.selection.some((s) => s.id === key.id);
        if (e.shiftKey) st.selection = inSel ? st.selection.filter((s) => s.id !== key.id) : [...st.selection, key];
        else if (!inSel) st.selection = [key];
        op = { type: 'move', last: [wx, wy], cp: false };
        if (e.detail >= 2 && hit.kind === 'text') { op = null; editText(hit.item); }
      } else if (inUnderlay(wx, wy) && !e.shiftKey && st.selection.length === 0) {
        op = { type: 'underlay', last: [wx, wy], cp: false };
      } else {
        if (!e.shiftKey) st.selection = [];
        op = { type: 'box', a: [wx, wy], b: [wx, wy], add: e.shiftKey };
      }
      updateChrome();
    }
    requestFrame();
  }

  function onMove(e) {
    const [sx, sy] = local(e);
    if (pointers.has(e.pointerId)) { const p = pointers.get(e.pointerId); p.x = sx; p.y = sy; }
    if (pinch) { movePinch(); return; }
    const [wx, wy] = toWorld(sx, sy);
    st.hover = [wx, wy];
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
        if (e.shiftKey) { op.stroke.points = [pts[0], [wx, wy, pts[0][2]]]; op.straight = true; break; }
        let evs = e.getCoalescedEvents?.();
        if (!evs?.length) evs = [e];
        const minD = 0.8 / z();
        for (const ev of evs) {
          const [cx, cy] = local(ev);
          const [qx, qy] = toWorld(cx, cy);
          const last = pts[pts.length - 1];
          if (Math.hypot(qx - last[0], qy - last[1]) < minD) continue;
          const p = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
          // light smoothing toward the previous point
          pts.push([last[0] * 0.25 + qx * 0.75, last[1] * 0.25 + qy * 0.75, last[2] * 0.4 + p * 0.6]);
        }
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
      case 'erase': eraseAt(wx, wy); break;
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
    pointers.delete(e.pointerId);
    if (pinch) {
      if ([...pointers.values()].filter((p) => p.type === 'touch').length < 2) pinch = null;
      return;
    }
    wrap.classList.remove('panning');
    if (!op) return;
    const cur = op;
    if (cur.type === 'wire') return; // wires are click-by-click
    op = null;
    if (e.type === 'pointercancel' && (cur.type === 'draw' || cur.type === 'shape')) { requestFrame(); return; }
    if (cur.type === 'draw') {
      const s = cur.stroke;
      if (s.points.length === 1) s.points.push([s.points[0][0] + 0.01, s.points[0][1], s.points[0][2]]);
      checkpoint(); d.strokes.push(s); changed();
    } else if (cur.type === 'shape') {
      const s = cur.stroke;
      const len = segLen(s.points[0], s.points[1]);
      if (len < 3 / z()) { requestFrame(); return; }
      if (s.tool === 'measure' && st.setScale) {
        const ans = await ui.promptDialog(`That line is ${Math.round(len)} units on the canvas. How many feet is it? (e.g. 12 or 12.5)`, { title: 'Set drawing scale', okLabel: 'Set scale' });
        const ft = parseFloat(ans);
        st.setScale = false;
        if (ft > 0) { checkpoint(); d.scale = len / ft; changed(); ui.toast(`Scale set: ${(d.scale).toFixed(1)} px per foot`, 'success'); }
        else { updateChrome(); requestFrame(); }
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

  // Safari pinch on trackpads
  let gestureZ = 1;
  const onGestureStart = (e) => { e.preventDefault(); gestureZ = 1; };
  const onGestureChange = (e) => { e.preventDefault(); const [sx, sy] = local(e); zoomAt(sx, sy, e.scale / gestureZ); gestureZ = e.scale; };

  // ---------- keyboard ----------
  function onKey(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('.sheet, .dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
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
    const items = st.selection.map((s) => ({ s, it: findSel(s) })).filter((x) => x.it && x.s.kind !== 'stroke');
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
  function updateZoom() { zoomLabel.textContent = `${Math.round(z() * 100)}%`; }

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
    const sizePx = Math.max(6, Math.min(30, (o.size || 4) * (isEraser ? 0.8 : 1.4)));
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
    if (st.placing) {
      parts.push(symbolPreview(st.placing, isDark() ? '#ecebe7' : '#1c1b19', 28), h('span', { class: 'cv-ctx-label' }, `${SYMBOLS[st.placing].label}: tap to place`),
        tbtn(RAW.rotate, 'Rotate 90°', () => { st.placeRot = (st.placeRot + 90) % 360; requestFrame(); }),
        h('button', { class: 'cv-chip', type: 'button', onClick: () => symbolsSheet() }, 'Change'),
        h('button', { class: 'cv-chip on', type: 'button', onClick: () => { st.placing = null; updateChrome(); requestFrame(); } }, 'Done'));
    } else if (st.tool === 'wire') {
      parts.push(h('span', { class: 'cv-ctx-label' }, op?.type === 'wire' ? `Wire: ${op.points.length} point${op.points.length === 1 ? '' : 's'}${d.scale ? ' · ' + fmtFeet(wireLength(op.points) / d.scale) : ''}` : 'Wire: tap points, tap twice to finish'),
        tbtn(RAW.dash, 'Dashed (low voltage)', () => { st.wireDash = !st.wireDash; if (op?.type === 'wire') op.proto.dash = st.wireDash; renderCtx(); requestFrame(); }, st.wireDash),
        tbtn(RAW.curve, 'Curved runs', () => { st.wireCurve = !st.wireCurve; if (op?.type === 'wire') op.proto.curve = st.wireCurve; renderCtx(); requestFrame(); }, st.wireCurve));
      if (op?.type === 'wire') parts.push(h('button', { class: 'cv-chip', type: 'button', onClick: () => { op = null; st.snap = null; updateChrome(); requestFrame(); } }, 'Cancel'),
        h('button', { class: 'cv-chip on', type: 'button', onClick: () => finishWire() }, 'Finish'));
    } else if (st.tool === 'measure') {
      parts.push(h('span', { class: 'cv-ctx-label' }, st.setScale ? 'Drag along a length you know' : `Scale: 1 ft = ${d.scale.toFixed(1)} units`),
        h('button', { class: ['cv-chip', st.setScale ? 'on' : null], type: 'button', onClick: () => { st.setScale = !st.setScale; renderCtx(); } }, st.setScale ? 'Cancel' : 'Set scale'));
    } else if (st.selection.length) {
      const hasObj = st.selection.some((s) => s.kind === 'object');
      const hasSized = st.selection.some((s) => s.kind !== 'stroke');
      parts.push(h('span', { class: 'cv-ctx-label' }, `${st.selection.length} selected`),
        tbtn('copy', 'Duplicate (Ctrl+D)', duplicateSel),
        hasObj ? tbtn(RAW.rotate, 'Rotate 45°', rotateSel) : null,
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
  function togglePop(force) {
    const show = force ?? pop.hidden;
    pop.hidden = !show;
    if (!show) return;
    ui.clear(pop);
    const t = st.tool;
    if (t === 'select' || t === 'hand') {
      // no brush here: just the colour used by "Apply current colour" and the next pen
      const pick = (c) => { lastColor = c; opts.pen.color = c; saveOpts(opts); if (st.selection.length) recolorSel(c); updateChrome(); togglePop(true); };
      pop.append(h('div', { class: 'cv-pop-title' }, st.selection.length ? 'Colour selection' : 'Colour'),
        h('div', { class: 'cv-swatches', role: 'group', 'aria-label': 'Colours' },
          SWATCHES.map((s) => h('button', { type: 'button', class: ['cv-swatch', s.c === lastColor ? 'on' : null], title: s.n, 'aria-label': s.n, style: { background: s.c }, onClick: () => pick(s.c) }))));
      return;
    }
    const o = opts[t] || opts.pen;
    const isEraser = t === 'eraser';
    const size = h('input', { type: 'range', min: isEraser ? 4 : 0.5, max: isEraser ? 80 : 40, step: 0.5, value: o.size, 'aria-label': 'Size',
      onInput: (e) => { o.size = Number(e.target.value); sizeOut.textContent = o.size; saveOpts(opts); updateChrome(); } });
    const sizeOut = h('output', null, String(o.size));
    const rows = [h('div', { class: 'cv-pop-title' }, `${ALL_TOOLS.find((x) => x.id === t)?.label || 'Brush'} settings`),
      h('label', { class: 'cv-range' }, h('span', null, 'Size'), size, sizeOut)];
    if (!isEraser && o.opacity != null && t !== 'measure') {
      const opOut = h('output', null, Math.round(o.opacity * 100) + '%');
      rows.push(h('label', { class: 'cv-range' }, h('span', null, 'Opacity'),
        h('input', { type: 'range', min: 10, max: 100, step: 5, value: Math.round(o.opacity * 100), 'aria-label': 'Opacity',
          onInput: (e) => { o.opacity = Number(e.target.value) / 100; opOut.textContent = e.target.value + '%'; saveOpts(opts); updateChrome(); } }), opOut));
    }
    if (!isEraser) {
      const pick = (c) => { o.color = c; lastColor = c; saveOpts(opts); updateChrome(); togglePop(true); };
      rows.push(h('div', { class: 'cv-swatches', role: 'group', 'aria-label': 'Colours (wire colours included)' },
        SWATCHES.map((s) => h('button', { type: 'button', class: ['cv-swatch', s.c.toLowerCase() === String(o.color).toLowerCase() ? 'on' : null], title: s.n, 'aria-label': s.n, style: { background: s.c }, onClick: () => pick(s.c) })),
        h('label', { class: 'cv-swatch custom', title: 'Custom colour' }, h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#1c1b19', 'aria-label': 'Custom colour', onChange: (e) => pick(e.target.value) }))));
    }
    pop.append(...rows);
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
          symbolPreview(sid, ink, 48), h('span', null, SYMBOLS[sid].label), priced ? h('small', { class: 'muted' }, ui.fmtMoney(priced.priceCents)) : null);
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
        const count = d.strokes.filter((x) => x.layer === l.id).length + d.objects.filter((x) => x.layer === l.id).length + d.texts.filter((x) => x.layer === l.id).length;
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
    const wireFt = d.scale > 0 ? wires.reduce((a, s) => a + wireLength(s.points), 0) / d.scale : 0;
    const s = ui.openSheet({
      title: 'Takeoff',
      body: h('div', { class: 'stack' },
        rows.length ? ui.table({
          columns: [
            { key: 'sym', label: '', render: (r) => symbolPreview(r.sid, ink, 32) },
            { key: 'label', label: 'Symbol', render: (r) => h('div', null, h('div', null, SYMBOLS[r.sid].label), h('div', { class: 'muted', style: { fontSize: '12px' } }, r.item ? r.item.sku : 'Not in price book')) },
            { key: 'n', label: 'Count', align: 'right', render: (r) => String(r.n) },
            { key: 'v', label: 'Value', align: 'right', render: (r) => r.item ? ui.fmtMoney(r.item.priceCents * r.n) : '—' },
          ], rows,
        }) : ui.empty({ icon: RAW.outlet, title: 'No symbols yet', text: 'Place receptacles, switches and lights from the Symbols library to count them here.' }),
        wires.length ? h('p', { class: 'muted', style: { margin: 0 } }, `${wires.length} wire run${wires.length === 1 ? '' : 's'} drawn, about ${Math.round(wireFt)} ft at the drawing scale.`) : null,
        rows.length ? h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Price-book value'), h('strong', { class: 'num' }, ui.fmtMoney(total))) : null),
      actions: [
        ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Create estimate', { variant: 'primary', icon: 'file-text', disabled: !rows.length, onClick: () => { s.close(); flushSave(); nav(`#/estimates/new?fromDrawing=${encodeURIComponent(id)}`); } }),
      ],
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
        { label: 'Scale (units per foot)', name: 'scale', type: 'number', step: 'any', min: 0.1, value: Math.round(d.scale * 100) / 100, hint: 'Or use Measure → Set scale on the plan.' },
      ],
      onSubmit: (v) => {
        d.name = v.name.trim() || 'Untitled';
        d.jobId = v.jobId || null;
        if (v.paper !== d.paper || (v.scale > 0 && v.scale !== d.scale)) { checkpoint(); d.paper = v.paper; if (v.scale > 0) d.scale = v.scale; }
        changed();
        save();
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
          row('ruler', 'Set scale', `1 ft = ${d.scale.toFixed(1)} units. Measure a known length on the plan.`, () => { setTool('measure'); st.setScale = true; updateChrome(); }),
          row('upload', 'Import plan', 'Image or PDF as an underlay', importUnderlay),
          row('list', 'Takeoff', 'Count symbols and create an estimate', takeoffSheet),
          row('image', 'Export PNG', 'High-resolution image', exportPNG),
          row('download', 'Export SVG', 'Vector file for CAD and print', exportSVG),
          job ? row('briefcase', 'Open job', `${job.number} · ${job.title}`, () => { flushSave(); nav('#/jobs/' + job.id); }) : null,
          row('trash', 'Delete drawing', 'Removes it from this device', async () => {
            if (!(await ui.confirmDialog(`Delete "${d.name}"? This can't be undone.`, { okLabel: 'Delete drawing' }))) return;
            clearTimeout(saveTimer); saveTimer = 0;
            store.remove('drawings', id);
            ui.toast('Drawing deleted');
            nav('#/drawings');
          }))),
    });
  }

  function cyclePaper() {
    const i = PAPERS.findIndex((p) => p.id === d.paper);
    const next = PAPERS[(i + 1) % PAPERS.length];
    checkpoint(); d.paper = next.id; changed();
    ui.toast(`Paper: ${next.label}`);
  }

  async function importUnderlay() {
    const file = await ui.pickFile('image/*,application/pdf');
    if (!file) return;
    try {
      let out;
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        ui.toast('Reading PDF…');
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        let pageNo = 1;
        if (pdf.numPages > 1) {
          const ans = await ui.promptDialog(`This PDF has ${pdf.numPages} pages. Which page is the plan?`, { title: 'Pick a page', value: '1', okLabel: 'Import' });
          if (ans == null) return;
          pageNo = Math.min(pdf.numPages, Math.max(1, parseInt(ans, 10) || 1));
        }
        const page = await pdf.getPage(pageNo);
        const v1 = page.getViewport({ scale: 1 });
        const k = Math.min(3, 4096 / Math.max(v1.width, v1.height));
        const vp = page.getViewport({ scale: k });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: cx, viewport: vp }).promise;
        out = flatten(c, c.width, c.height);
      } else if (file.type.startsWith('image/')) {
        const img = await loadImage(await readAsDataURL(file));
        out = flatten(img, img.naturalWidth, img.naturalHeight);
      } else {
        ui.toast('Pick an image or a PDF', 'error');
        return;
      }
      checkpoint();
      d.underlay = out.url;
      d.underlayW = out.w; d.underlayH = out.h;
      d.underlayX = 0; d.underlayY = 0;
      d.underlayLocked = true;
      d.underlayOpacity = d.underlayOpacity ?? 1;
      loadUnderlay();
      changed();
      underImg.addEventListener('load', () => fit(), { once: true });
      ui.toast('Plan imported. Set the scale with Measure → Set scale.', 'success', 4000);
    } catch (err) {
      console.warn(err);
      ui.toast(err?.message || 'Could not import that file', 'error', 4000);
    }
  }

  const fileName = (ext) => `${(d.name || 'drawing').replace(/[^\w\- ]+/g, '').trim() || 'drawing'}.${ext}`;
  function exportPNG() {
    const c = renderToCanvas(d, { underlayImage: underImg, scale: 2, maxW: 6000, maxH: 6000 });
    c.toBlob((blob) => {
      if (!blob) return ui.toast('Export failed', 'error');
      ui.download(fileName('png'), blob, 'image/png');
      store.log('export', `Exported ${d.name} as PNG`, 'drawings', id);
    }, 'image/png');
  }
  function exportSVG() {
    ui.download(fileName('svg'), toSVG(d), 'image/svg+xml');
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

  loadUnderlay();
  resize();
  updateChrome();

  // exposed for tests
  globalThis.kelbeCanvas = { d, st, setTool, fit, takeoff: () => takeoff(d), save: () => save() };

  return () => {
    destroyed = true;
    flushSave();
    cancelAnimationFrame(rafId);
    ro.disconnect(); mo.disconnect();
    mq.removeEventListener?.('change', onScheme);
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKey);
    removeEventListener('pagehide', flushSave);
    document.removeEventListener('visibilitychange', onHide);
    document.body.classList.remove('canvas-open');
    root.classList.remove('full-bleed');
    if (globalThis.kelbeCanvas?.d === d) delete globalThis.kelbeCanvas;
  };
}
