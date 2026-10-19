// Rendering, hit-testing and export for drawings. Pure functions over the
// drawing record (see replica/architecture.md, `drawings`). World units are
// canvas pixels at zoom 1; `scale` is world px per foot.
import { drawSymbol, symbolSVG } from './symbols.js';

export const LIGHT_PAPER = { bg: '#f7f6f2', line: 'rgba(28,27,25,0.10)' };
export const FREEHAND = new Set(['pen', 'pencil', 'marker', 'highlighter']);
const SYMBOL_HIT = 15; // grab radius in world units; symbols are drawn ~12 units out

// ---------- colour helpers ----------
function lum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** On dark paper, near-black ink is shown light so it stays readable. */
export function inkFor(color, dark) {
  if (dark && lum(color) < 0.06) return '#ecebe7';
  return color;
}
const needsHalo = (color, dark) => !dark && lum(color) > 0.85;

// ---------- paper ----------
/** Paper pattern in screen space for the given view. */
export function drawPaper(ctx, view, w, h, paper, colors) {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);
  if (!paper || paper === 'none') return;
  let step = 24;
  while (step * view.zoom < 10) step *= 5;
  const s = step * view.zoom;
  ctx.save();
  ctx.strokeStyle = colors.line;
  ctx.fillStyle = colors.line;
  ctx.lineWidth = 1;
  if (paper === 'grid' || paper === 'dots') {
    const ox = ((view.x % s) + s) % s, oy = ((view.y % s) + s) % s;
    if (paper === 'grid') {
      ctx.beginPath();
      for (let x = ox; x < w; x += s) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
      for (let y = oy; y < h; y += s) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.stroke();
      // every 5th line a little stronger, like engineering paper
      const big = s * 5;
      const bx = ((view.x % big) + big) % big, by = ((view.y % big) + big) % big;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let x = bx; x < w; x += big) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
      for (let y = by; y < h; y += big) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.stroke();
    } else {
      const r = Math.max(1, Math.min(1.8, s / 14));
      for (let x = ox; x < w; x += s) for (let y = oy; y < h; y += s) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
  } else if (paper === 'iso') {
    // isometric: verticals every s*cos30, plus two families at ±30°
    const dx = s * Math.cos(Math.PI / 6);
    const t = Math.tan(Math.PI / 6);
    ctx.beginPath();
    const ox = ((view.x % dx) + dx) % dx;
    for (let x = ox; x < w; x += dx) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    // lines y = ±t*(x - view.x) + view.y + k*s  -> intercept at screen x=0
    for (const sign of [1, -1]) {
      const base = view.y - sign * t * view.x; // y at x=0 for k=0
      const span = t * w;
      const kMin = Math.floor((-span - base) / s) - 1, kMax = Math.ceil((h + span - base) / s) + 1;
      for (let k = kMin; k <= kMax; k++) {
        const y0 = base + k * s;
        ctx.moveTo(0, y0); ctx.lineTo(w, y0 + sign * t * w);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- strokes ----------
function freehandPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length < 3) { for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); return; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/** Pressure-varying stroke: each smoothed segment gets its own width. */
function pressureStroke(ctx, pts, size, minF) {
  if (pts.length < 3) {
    ctx.lineWidth = size * (minF + (1 - minF) * (pts[0][2] ?? 0.5));
    freehandPath(ctx, pts);
    ctx.stroke();
    return;
  }
  let px = pts[0][0], py = pts[0][1];
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    const p = pts[i][2] ?? 0.5;
    ctx.lineWidth = Math.max(0.4, size * (minF + (1 - minF) * p));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    ctx.stroke();
    px = mx; py = my;
  }
}

function wirePath(ctx, pts, curve) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    if (curve) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const nx = -(by - ay) * 0.22, ny = (bx - ax) * 0.22;
      ctx.quadraticCurveTo(mx + nx, my + ny, bx, by);
    } else ctx.lineTo(bx, by);
  }
}

export function fmtFeet(feet) {
  if (!Number.isFinite(feet)) return '—';
  const totalIn = Math.round(feet * 12);
  const ft = Math.floor(totalIn / 12), inch = totalIn % 12;
  return inch ? `${ft}′ ${inch}″` : `${ft}′`;
}
export const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function wireLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += segLen(pts[i - 1], pts[i]); return s; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function measureLabel(ctx, d, a, b, color, zoom) {
  const ft = d.scale > 0 ? segLen(a, b) / d.scale : NaN;
  const label = fmtFeet(ft);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const fs = 12 / zoom;
  ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = '#1c1b19';
  roundRect(ctx, mx - tw / 2 - 6 / zoom, my - fs * 0.85, tw + 12 / zoom, fs * 1.7, fs * 0.85);
  ctx.fill();
  ctx.fillStyle = '#f5b301';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my + 0.5 / zoom);
}

/** Draw one stroke in world space. */
export function drawStroke(ctx, s, d, opts = {}) {
  const pts = s.points;
  if (!pts?.length) return;
  const dark = !!opts.dark, zoom = opts.zoom || 1;
  const color = inkFor(s.color, dark);
  ctx.save();
  ctx.lineCap = s.tool === 'highlighter' ? 'butt' : 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha *= s.opacity ?? 1;
  const halo = needsHalo(s.color, dark);
  const paint = (strokeColor, extra) => {
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    const size = s.size + extra;
    switch (s.tool) {
      case 'pen': pressureStroke(ctx, pts, size, 0.3); break;
      case 'pencil': ctx.globalAlpha *= 0.85; pressureStroke(ctx, pts, size, 0.55); break;
      case 'marker': ctx.lineWidth = size; freehandPath(ctx, pts); ctx.stroke(); break;
      case 'highlighter': ctx.globalAlpha *= 0.38; ctx.lineWidth = size; freehandPath(ctx, pts); ctx.stroke(); break;
      case 'line': ctx.lineWidth = size; ctx.beginPath(); ctx.moveTo(...pts[0].slice(0, 2)); ctx.lineTo(...pts[pts.length - 1].slice(0, 2)); ctx.stroke(); break;
      case 'rect': {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        ctx.lineWidth = size; ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        break;
      }
      case 'wire': {
        ctx.lineWidth = size;
        if (s.dash) ctx.setLineDash([size * 4, size * 3]);
        wirePath(ctx, pts, s.curve);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!extra) for (const p of [pts[0], pts[pts.length - 1]]) { ctx.beginPath(); ctx.arc(p[0], p[1], size * 1.3, 0, Math.PI * 2); ctx.fill(); }
        break;
      }
      case 'measure': {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        ctx.lineWidth = 1.5 / zoom * (extra ? 2 : 1);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2, t = 7 / zoom;
        for (const p of [a, b]) { ctx.moveTo(p[0] - Math.cos(ang) * t, p[1] - Math.sin(ang) * t); ctx.lineTo(p[0] + Math.cos(ang) * t, p[1] + Math.sin(ang) * t); }
        ctx.stroke();
        if (!extra) measureLabel(ctx, d, a, b, color, zoom);
        break;
      }
      default: ctx.lineWidth = size; freehandPath(ctx, pts); ctx.stroke();
    }
  };
  if (halo) { ctx.save(); paint('#8a8478', 1.6); ctx.restore(); }
  paint(color, 0);
  ctx.restore();
}

export function drawObject(ctx, o, opts = {}) {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
  const sc = o.scale || 1;
  ctx.scale(sc, sc);
  drawSymbol(ctx, o.symbol, inkFor(o.color || '#1c1b19', opts.dark), 2);
  ctx.restore();
}

export const textFont = (t) => `500 ${t.size || 18}px Inter, system-ui, sans-serif`;

export function drawText(ctx, t, opts = {}) {
  ctx.save();
  ctx.font = textFont(t);
  ctx.fillStyle = inkFor(t.color || '#1c1b19', opts.dark);
  ctx.textBaseline = 'top';
  String(t.text).split('\n').forEach((line, i) => ctx.fillText(line, t.x, t.y + i * (t.size || 18) * 1.25));
  ctx.restore();
}

/** Draw all visible layers (and the underlay) in world space. */
// Dark mode shows plans inverted (white lines on dark), so light-mapped ink stays readable on them.
const invertedCache = new WeakMap();
function inverted(img) {
  if (invertedCache.has(img)) return invertedCache.get(img);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'difference';
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  invertedCache.set(img, c);
  return c;
}

export function drawContent(ctx, d, opts = {}) {
  const img = opts.underlayImage;
  if (d.underlay && img?.complete && img.naturalWidth) {
    ctx.save();
    ctx.globalAlpha = d.underlayOpacity ?? 1;
    ctx.drawImage(opts.dark ? inverted(img) : img, d.underlayX || 0, d.underlayY || 0, d.underlayW || img.naturalWidth, d.underlayH || img.naturalHeight);
    ctx.restore();
  }
  for (const layer of d.layers) {
    if (layer.visible === false) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1;
    for (const s of d.strokes) if (s.layer === layer.id) drawStroke(ctx, s, d, opts);
    for (const o of d.objects) if (o.layer === layer.id) drawObject(ctx, o, opts);
    for (const t of d.texts || []) if (t.layer === layer.id) drawText(ctx, t, opts);
    ctx.restore();
  }
}

// ---------- geometry ----------
const boundsCache = new WeakMap();
export function strokeBounds(s) {
  if (boundsCache.has(s)) return boundsCache.get(s);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const pad = (s.size || 2) / 2 + (s.tool === 'wire' && s.curve ? wireLength(s.points) * 0.12 : 0);
  const b = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  boundsCache.set(s, b);
  return b;
}

let measureCtx;
export function textBounds(t) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = textFont(t);
  const lines = String(t.text).split('\n');
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width));
  return { x0: t.x, y0: t.y, x1: t.x + w, y1: t.y + lines.length * (t.size || 18) * 1.25 };
}

export function objectBounds(o) {
  const r = (SYMBOL_HIT + 2) * (o.scale || 1);
  return { x0: o.x - r, y0: o.y - r, x1: o.x + r, y1: o.y + r };
}

export function itemBounds(kind, item) {
  return kind === 'stroke' ? strokeBounds(item) : kind === 'object' ? objectBounds(item) : textBounds(item);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitStroke(s, x, y, tol) {
  const b = strokeBounds(s);
  if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return false;
  const r = tol + (s.size || 2) / 2;
  const p = s.points;
  if (s.tool === 'rect') {
    const [a, c] = [p[0], p[p.length - 1]];
    const corners = [[a[0], a[1]], [c[0], a[1]], [c[0], c[1]], [a[0], c[1]]];
    return corners.some((q, i) => { const n = corners[(i + 1) % 4]; return distToSeg(x, y, q[0], q[1], n[0], n[1]) <= r; });
  }
  if (s.tool === 'wire' && s.curve) return true; // inside bounds is close enough for arcs
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= r;
  const pts = s.tool === 'line' || s.tool === 'measure' ? [p[0], p[p.length - 1]] : p;
  for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
  return false;
}

/** Topmost item at a world point on usable layers. Returns { kind, item } or null. */
export function hitTest(d, x, y, tol, layerOk = () => true) {
  for (let li = d.layers.length - 1; li >= 0; li--) {
    const layer = d.layers[li];
    if (!layerOk(layer)) continue;
    const texts = (d.texts || []).filter((t) => t.layer === layer.id);
    for (let i = texts.length - 1; i >= 0; i--) {
      const b = textBounds(texts[i]);
      if (x >= b.x0 - tol && x <= b.x1 + tol && y >= b.y0 - tol && y <= b.y1 + tol) return { kind: 'text', item: texts[i] };
    }
    const objs = d.objects.filter((o) => o.layer === layer.id);
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (Math.hypot(x - o.x, y - o.y) <= SYMBOL_HIT * (o.scale || 1) + tol) return { kind: 'object', item: o };
    }
    const strokes = d.strokes.filter((s) => s.layer === layer.id);
    for (let i = strokes.length - 1; i >= 0; i--) if (hitStroke(strokes[i], x, y, tol)) return { kind: 'stroke', item: strokes[i] };
  }
  return null;
}

export function contentBounds(d, includeUnderlay = true) {
  let b = null;
  const grow = (o) => { b = b ? { x0: Math.min(b.x0, o.x0), y0: Math.min(b.y0, o.y0), x1: Math.max(b.x1, o.x1), y1: Math.max(b.y1, o.y1) } : { ...o }; };
  const visible = new Set(d.layers.filter((l) => l.visible !== false).map((l) => l.id));
  for (const s of d.strokes) if (visible.has(s.layer)) grow(strokeBounds(s));
  for (const o of d.objects) if (visible.has(o.layer)) grow(objectBounds(o));
  for (const t of d.texts || []) if (visible.has(t.layer)) grow(textBounds(t));
  if (includeUnderlay && d.underlay && d.underlayW) grow({ x0: d.underlayX || 0, y0: d.underlayY || 0, x1: (d.underlayX || 0) + d.underlayW, y1: (d.underlayY || 0) + d.underlayH });
  return b;
}

// ---------- export ----------
/** Render the whole drawing to a new canvas (light paper). */
export function renderToCanvas(d, { maxW = 4000, maxH = 4000, pad = 40, scale = 2, paper = true, underlayImage, fixed } = {}) {
  const b = contentBounds(d) || { x0: 0, y0: 0, x1: 400, y1: 300 };
  const ww = b.x1 - b.x0 + pad * 2, wh = b.y1 - b.y0 + pad * 2;
  let z = scale;
  if (fixed) z = Math.min(fixed.w / ww, fixed.h / wh);
  else z = Math.min(scale, maxW / ww, maxH / wh);
  const W = fixed ? fixed.w : Math.max(1, Math.round(ww * z)), H = fixed ? fixed.h : Math.max(1, Math.round(wh * z));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const offX = fixed ? (W - ww * z) / 2 : 0, offY = fixed ? (H - wh * z) / 2 : 0;
  const view = { x: offX + (pad - b.x0) * z, y: offY + (pad - b.y0) * z, zoom: z };
  drawPaper(ctx, view, W, H, paper ? d.paper : 'none', LIGHT_PAPER);
  ctx.setTransform(z, 0, 0, z, view.x, view.y);
  drawContent(ctx, d, { zoom: z, dark: false, underlayImage });
  return c;
}

const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function svgPathFor(s) {
  const p = s.points;
  const f = (n) => Math.round(n * 100) / 100;
  if (s.tool === 'rect') {
    const [a, b] = [p[0], p[p.length - 1]];
    return `M${f(Math.min(a[0], b[0]))} ${f(Math.min(a[1], b[1]))}h${f(Math.abs(b[0] - a[0]))}v${f(Math.abs(b[1] - a[1]))}h${f(-Math.abs(b[0] - a[0]))}z`;
  }
  if (s.tool === 'line' || s.tool === 'measure') return `M${f(p[0][0])} ${f(p[0][1])}L${f(p[p.length - 1][0])} ${f(p[p.length - 1][1])}`;
  if (s.tool === 'wire') {
    let out = `M${f(p[0][0])} ${f(p[0][1])}`;
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      if (s.curve) out += `Q${f((ax + bx) / 2 - (by - ay) * 0.22)} ${f((ay + by) / 2 + (bx - ax) * 0.22)} ${f(bx)} ${f(by)}`;
      else out += `L${f(bx)} ${f(by)}`;
    }
    return out;
  }
  if (p.length < 3) return `M${f(p[0][0])} ${f(p[0][1])}` + p.slice(1).map((q) => `L${f(q[0])} ${f(q[1])}`).join('') + (p.length === 1 ? 'l0.01 0' : '');
  let out = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) out += `Q${f(p[i][0])} ${f(p[i][1])} ${f((p[i][0] + p[i + 1][0]) / 2)} ${f((p[i][1] + p[i + 1][1]) / 2)}`;
  const l = p[p.length - 1];
  return out + `L${f(l[0])} ${f(l[1])}`;
}

/** Vector export. Pressure strokes use their average width. */
export function toSVG(d) {
  const pad = 40;
  const b = contentBounds(d) || { x0: 0, y0: 0, x1: 400, y1: 300 };
  const x = b.x0 - pad, y = b.y0 - pad, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">`,
    `<title>${escX(d.name || 'Drawing')}</title>`, `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${LIGHT_PAPER.bg}"/>`];
  if (d.underlay && d.underlayW) out.push(`<image href="${d.underlay}" x="${d.underlayX || 0}" y="${d.underlayY || 0}" width="${d.underlayW}" height="${d.underlayH}" opacity="${d.underlayOpacity ?? 1}"/>`);
  for (const layer of d.layers) {
    if (layer.visible === false) continue;
    out.push(`<g id="${escX(layer.name)}" opacity="${layer.opacity ?? 1}">`);
    for (const s of d.strokes.filter((q) => q.layer === layer.id)) {
      const avgP = s.points.reduce((a, q) => a + (q[2] ?? 0.5), 0) / s.points.length;
      const width = s.tool === 'pen' ? s.size * (0.3 + 0.7 * avgP) : s.tool === 'pencil' ? s.size * (0.55 + 0.45 * avgP) : s.tool === 'measure' ? 1.5 : s.size;
      const op = (s.opacity ?? 1) * (s.tool === 'highlighter' ? 0.38 : s.tool === 'pencil' ? 0.85 : 1);
      const dash = s.dash ? ` stroke-dasharray="${s.size * 4} ${s.size * 3}"` : '';
      out.push(`<path d="${svgPathFor(s)}" fill="none" stroke="${s.color}" stroke-width="${Math.round(width * 100) / 100}" stroke-opacity="${op}" stroke-linecap="${s.tool === 'highlighter' ? 'butt' : 'round'}" stroke-linejoin="round"${dash}/>`);
      if (s.tool === 'measure' && d.scale > 0) {
        const [a, c] = [s.points[0], s.points[s.points.length - 1]];
        out.push(`<text x="${(a[0] + c[0]) / 2}" y="${(a[1] + c[1]) / 2 - 6}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle" fill="${s.color}">${escX(fmtFeet(segLen(a, c) / d.scale))}</text>`);
      }
    }
    for (const o of d.objects.filter((q) => q.layer === layer.id)) {
      out.push(`<g transform="translate(${o.x} ${o.y}) rotate(${o.rotation || 0}) scale(${o.scale || 1})">${symbolSVG(o.symbol, o.color || '#1c1b19')}</g>`);
    }
    for (const t of (d.texts || []).filter((q) => q.layer === layer.id)) {
      const lines = String(t.text).split('\n');
      out.push(`<text x="${t.x}" y="${t.y}" font-family="Inter, system-ui, sans-serif" font-size="${t.size || 18}" fill="${t.color || '#1c1b19'}" dominant-baseline="hanging">${lines.map((l, i) => `<tspan x="${t.x}" dy="${i ? (t.size || 18) * 1.25 : 0}">${escX(l)}</tspan>`).join('')}</text>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

/** Symbol counts on visible layers: { symbolId: n }. */
export function takeoff(d) {
  const visible = new Set(d.layers.filter((l) => l.visible !== false).map((l) => l.id));
  const counts = {};
  for (const o of d.objects) if (visible.has(o.layer)) counts[o.symbol] = (counts[o.symbol] || 0) + 1;
  return counts;
}
