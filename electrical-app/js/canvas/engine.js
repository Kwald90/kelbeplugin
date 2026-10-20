// Rendering, hit-testing and export for drawings. Pure functions over the
// drawing record (see replica/architecture.md, `drawings`). World units are
// canvas pixels at zoom 1; `scale` is world px per foot. Rooms (`rooms[]`,
// see js/lib/placement.js) draw on whichever layer they belong to.
import { drawSymbol, symbolSVG } from './symbols.js';
import { fmtLength, getUnits, M_PER_FT } from '../lib/units.js';
import {
  pxPerM, roomGeometry, featureSpan, featureCorners, wallPoint, interiorPoint, polyBounds, pointInPoly,
} from '../lib/placement.js';
import { ROOM_TYPES } from '../lib/placement-rules.js';
import { inkSegments } from './ink.js';

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
// Smoothed midpoint to midpoint, with sharp corners (the tip of a V) kept sharp: see ./ink.js.
function freehandPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const sg of inkSegments(pts)) {
    if (sg.q) ctx.quadraticCurveTo(sg.q[0], sg.q[1], sg.to[0], sg.to[1]);
    else ctx.lineTo(sg.to[0], sg.to[1]);
  }
}

/** Pressure-varying stroke: each smoothed segment gets its own width. */
function pressureStroke(ctx, pts, size, minF) {
  const width = (p) => Math.max(0.4, size * (minF + (1 - minF) * (p ?? 0.5)));
  if (pts.length < 3) {
    ctx.lineWidth = width(pts[0][2]);
    freehandPath(ctx, pts);
    ctx.stroke();
    return;
  }
  let [px, py] = pts[0];
  for (const sg of inkSegments(pts)) {
    ctx.lineWidth = width(sg.p);
    ctx.beginPath();
    ctx.moveTo(px, py);
    if (sg.q) ctx.quadraticCurveTo(sg.q[0], sg.q[1], sg.to[0], sg.to[1]);
    else ctx.lineTo(sg.to[0], sg.to[1]);
    ctx.stroke();
    [px, py] = sg.to;
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

/** A canvas length in the user's units: 12' 6" or 3.81 m. */
export function fmtWorldLength(px, d, units = getUnits()) {
  if (!(d.scale > 0)) return '—';
  return fmtLength((px / d.scale) * M_PER_FT, { units, denom: 4 });
}

function measureLabel(ctx, d, a, b, color, zoom, units) {
  const label = fmtWorldLength(segLen(a, b), d, units);
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
        if (!extra) measureLabel(ctx, d, a, b, color, zoom, opts.units);
        break;
      }
      default: ctx.lineWidth = size; freehandPath(ctx, pts); ctx.stroke();
    }
  };
  if (halo) { ctx.save(); paint('#8a8478', 1.6); ctx.restore(); }
  paint(color, 0);
  ctx.restore();
}

/** Short protection marks for a symbol: GF (GFCI-protected), AF, TR, WP, SW (switched). */
export function deviceTags(o) {
  const f = o.flags || {};
  const t = [];
  if (f.gfci && o.symbol !== 'receptacle-gfci') t.push('GF');
  if (f.afci) t.push('AF');
  if (f.tr) t.push('TR');
  if (f.wp) t.push('WP');
  if (f.switched) t.push('SW');
  if (o.symbol === 'smoke' && f.co === false) t.push('SMK');
  return t.join(' ');
}

export function drawObject(ctx, o, opts = {}) {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
  const sc = o.scale || 1;
  ctx.scale(sc, sc);
  const ink = inkFor(o.color || '#1c1b19', opts.dark);
  drawSymbol(ctx, o.symbol, ink, 2);
  ctx.restore();
  const tags = deviceTags(o);
  if (tags) {
    ctx.save();
    ctx.fillStyle = ink;
    ctx.globalAlpha *= 0.8;
    ctx.font = `700 ${7 * sc}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(tags, o.x + 13 * sc, o.y - 13 * sc);
    ctx.restore();
  }
}

// ---------- rooms ----------
const ROOM_TINT = {
  bedroom: '#7a3fb0', living: '#1f5fb8', kitchen: '#e07a1f', dining: '#d6457a', bathroom: '#0e8a8a', hallway: '#8a8478',
  laundry: '#0e8a8a', garage: '#5f5a51', basement: '#7a4a24', outdoor: '#1d7044', other: '#8a8478',
};
const geoCache = new WeakMap();
/** Geometry for a room at the drawing's scale, cached until its points or the scale change. */
export function roomGeo(room, d) {
  const key = `${d.scale}|${room.points.map((p) => p[0] + ',' + p[1]).join(';')}`;
  const c = geoCache.get(room);
  if (c && c.key === key) return c.geo;
  const geo = roomGeometry(room, pxPerM(d.scale));
  // the name sits a little below the middle, where the ceiling light usually goes
  const [ix, iy] = interiorPoint(geo);
  geo.label = pointInPoly(ix, iy + 30, room.points) ? [ix, iy + 30] : [ix, iy];
  geoCache.set(room, { key, geo });
  return geo;
}

/** "4.00 × 3.50 m" for a rectangle, else the floor area. */
export function roomSizeLabel(room, d, units = getUnits()) {
  const geo = roomGeo(room, d);
  const w = geo.walls;
  const rect = w.length === 4 && w.every((x, i) => Math.abs(x.u[0] * w[(i + 1) % 4].u[0] + x.u[1] * w[(i + 1) % 4].u[1]) < 0.02);
  if (rect) return `${fmtLength(w[0].lenM, { units, denom: 2 })} × ${fmtLength(w[1].lenM, { units, denom: 2 })}`;
  return units === 'imperial' ? `${Math.round(geo.areaM2 / (M_PER_FT * M_PER_FT))} sq ft` : `${geo.areaM2.toFixed(1)} m²`;
}

function wallPieces(geo, room) {
  // each wall minus door and opening gaps, as [wall, a, b] in metres
  const out = [];
  for (const w of geo.walls) {
    const gaps = (room.features || []).filter((f) => f.wall === w.i && (f.kind === 'door' || f.kind === 'opening')).map((f) => featureSpan(geo, f)).filter(Boolean).sort((p, q) => p.a - q.a);
    let cur = 0;
    for (const g of gaps) { if (g.a > cur) out.push([w.i, cur, g.a]); cur = Math.max(cur, g.b); }
    if (w.lenM > cur) out.push([w.i, cur, w.lenM]);
  }
  return out;
}

function polyPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
}

/** Draw one room: floor tint, walls with door gaps and swings, windows, fixtures, name and wall dimensions. */
export function drawRoom(ctx, room, d, opts = {}) {
  if (!room.points || room.points.length < 3) return;
  const geo = roomGeo(room, d);
  const dark = !!opts.dark, units = opts.units || getUnits();
  const ink = dark ? '#ecebe7' : '#3d3a35', muted = dark ? '#a6a39b' : '#7a756b';
  const tint = ROOM_TINT[room.type] || ROOM_TINT.other;
  ctx.save();
  polyPath(ctx, room.points);
  ctx.globalAlpha *= 0.07;
  ctx.fillStyle = tint;
  ctx.fill();
  ctx.restore();

  // fixtures and built-ins under the walls
  for (const f of room.features || []) {
    if (['door', 'opening', 'window'].includes(f.kind)) continue;
    const c = featureCorners(geo, f);
    if (!c) continue;
    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = muted;
    ctx.fillStyle = dark ? 'rgba(236,235,231,0.06)' : 'rgba(28,27,25,0.05)';
    polyPath(ctx, c);
    ctx.fill(); ctx.stroke();
    const cx = (c[0][0] + c[2][0]) / 2, cy = (c[0][1] + c[2][1]) / 2;
    const span = Math.min(Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]));
    if (f.kind === 'obstruction') {
      ctx.save(); polyPath(ctx, c); ctx.clip();
      ctx.beginPath();
      const b = polyBounds(c);
      for (let x = b.x0 - (b.y1 - b.y0); x < b.x1; x += 7) { ctx.moveTo(x, b.y1); ctx.lineTo(x + (b.y1 - b.y0), b.y0); }
      ctx.globalAlpha *= 0.5; ctx.stroke(); ctx.restore();
    } else if (f.kind === 'sink' || f.kind === 'tub') {
      const k = f.kind === 'tub' ? 0.16 : 0.22;
      const inner = c.map((p) => [cx + (p[0] - cx) * (1 - k), cy + (p[1] - cy) * (1 - k)]);
      ctx.strokeStyle = dark ? '#7fb2ff' : '#1f5fb8';
      polyPath(ctx, inner); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, span * 0.06), 0, Math.PI * 2); ctx.stroke();
    } else if (f.kind === 'shower') {
      ctx.strokeStyle = dark ? '#7fb2ff' : '#1f5fb8';
      ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]); ctx.lineTo(c[2][0], c[2][1]); ctx.moveTo(c[1][0], c[1][1]); ctx.lineTo(c[3][0], c[3][1]); ctx.stroke();
    } else if (f.kind === 'cooktop') {
      for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.arc(cx + ux * span * 0.2, cy + uy * span * 0.2, span * 0.12, 0, Math.PI * 2); ctx.stroke(); }
    } else if (f.kind === 'island' && f.sink) {
      ctx.strokeStyle = dark ? '#7fb2ff' : '#1f5fb8';
      ctx.beginPath(); ctx.arc(cx, cy, span * 0.22, 0, Math.PI * 2); ctx.stroke();
    }
    const tag = { range: f.gas ? 'GAS' : 'R', fridge: 'REF', washer: 'W', island: f.peninsula ? 'PEN' : '' }[f.kind];
    if (tag) {
      ctx.fillStyle = muted; ctx.font = `700 ${Math.max(6, Math.min(11, span * 0.3))}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tag, cx, cy);
    }
    ctx.restore();
  }

  // walls, with gaps at doors and openings
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 4;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const [i, a, b] of wallPieces(geo, room)) {
    const p = wallPoint(geo, i, a, -0.04), q = wallPoint(geo, i, b, -0.04);
    ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
  }
  ctx.stroke();
  // windows: thin double line on the wall
  ctx.lineWidth = 1;
  for (const f of (room.features || []).filter((x) => x.kind === 'window')) {
    const sp = featureSpan(geo, f);
    if (!sp) continue;
    ctx.strokeStyle = dark ? '#1d1f22' : '#f7f6f2';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    let p = wallPoint(geo, f.wall, sp.a, -0.04), q = wallPoint(geo, f.wall, sp.b, -0.04);
    ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    ctx.strokeStyle = dark ? '#7fb2ff' : '#1f5fb8';
    ctx.lineWidth = 0.9;
    if (f.toFloor) ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (const off of [-0.02, -0.06]) {
      p = wallPoint(geo, f.wall, sp.a, off); q = wallPoint(geo, f.wall, sp.b, off);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // doors: leaf and swing arc
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = ink;
  for (const f of (room.features || []).filter((x) => x.kind === 'door')) {
    const sp = featureSpan(geo, f);
    if (!sp) continue;
    const width = sp.b - sp.a;
    const hingeT = f.hinge === 'end' ? sp.b : sp.a, latchT = f.hinge === 'end' ? sp.a : sp.b;
    const dir = f.swing === 'out' ? -1 : 1;
    const hp = wallPoint(geo, f.wall, hingeT, 0), lp = wallPoint(geo, f.wall, latchT, 0), leaf = wallPoint(geo, f.wall, hingeT, dir * width);
    ctx.beginPath(); ctx.moveTo(hp[0], hp[1]); ctx.lineTo(leaf[0], leaf[1]); ctx.stroke();
    const r = width * geo.ppm;
    const a0 = Math.atan2(leaf[1] - hp[1], leaf[0] - hp[0]), a1 = Math.atan2(lp[1] - hp[1], lp[0] - hp[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    ctx.save(); ctx.setLineDash([3, 3]); ctx.globalAlpha *= 0.7;
    ctx.beginPath(); ctx.arc(hp[0], hp[1], r, a0, a0 + da, da < 0); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // wall dimensions, outside each wall
  ctx.save();
  ctx.fillStyle = muted;
  ctx.font = '600 9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const w of geo.walls) {
    if (w.lenM < 0.5) continue;
    const [x, y] = wallPoint(geo, w.i, w.lenM / 2, -16 / geo.ppm);
    ctx.save();
    ctx.translate(x, y);
    let ang = w.angle;
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.rotate(ang);
    ctx.fillText(fmtLength(w.lenM, { units, denom: 2 }), 0, 0);
    ctx.restore();
  }
  // name and size
  const [lx, ly] = geo.label;
  const halo = (text, x, y) => { ctx.strokeText(text, x, y); ctx.fillText(text, x, y); };
  ctx.lineJoin = 'round';
  ctx.strokeStyle = dark ? 'rgba(29,31,34,0.85)' : 'rgba(247,246,242,0.85)';
  ctx.lineWidth = 3;
  ctx.fillStyle = ink;
  ctx.font = '700 13px Inter, system-ui, sans-serif';
  halo(room.name || ROOM_TYPES[room.type]?.label || 'Room', lx, ly - 7);
  ctx.fillStyle = muted;
  ctx.font = '500 10px Inter, system-ui, sans-serif';
  halo(`${ROOM_TYPES[room.type]?.label || 'Room'} · ${roomSizeLabel(room, d, units)}`, lx, ly + 8);
  ctx.restore();
}

export function roomBounds(room) { return polyBounds(room.points); }

/** A room is hit on its walls or its name label, not anywhere inside (so taps inside still select symbols). */
export function hitRoom(room, d, x, y, tol) {
  if (!room.points || room.points.length < 3) return false;
  const geo = roomGeo(room, d);
  for (const w of geo.walls) if (distToSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]) <= tol + 3) return true;
  const [lx, ly] = geo.label;
  return Math.abs(x - lx) <= 60 + tol && Math.abs(y - ly) <= 14 + tol && pointInPoly(x, y, room.points);
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
    for (const r of d.rooms || []) if (r.layer === layer.id) drawRoom(ctx, r, d, opts);
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
  return kind === 'stroke' ? strokeBounds(item) : kind === 'object' ? objectBounds(item) : kind === 'room' ? roomBounds(item) : textBounds(item);
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
    const rooms = (d.rooms || []).filter((r) => r.layer === layer.id);
    for (let i = rooms.length - 1; i >= 0; i--) if (hitRoom(rooms[i], d, x, y, tol)) return { kind: 'room', item: rooms[i] };
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
  for (const r of d.rooms || []) {
    if (!visible.has(r.layer) || !r.points?.length) continue;
    const b0 = roomBounds(r);
    grow({ x0: b0.x0 - 24, y0: b0.y0 - 24, x1: b0.x1 + 24, y1: b0.y1 + 24 });
  }
  if (includeUnderlay && d.underlay && d.underlayW) grow({ x0: d.underlayX || 0, y0: d.underlayY || 0, x1: (d.underlayX || 0) + d.underlayW, y1: (d.underlayY || 0) + d.underlayH });
  return b;
}

// ---------- export ----------
/** Render the whole drawing to a new canvas (light paper). */
export function renderToCanvas(d, { maxW = 4000, maxH = 4000, pad = 40, scale = 2, paper = true, underlayImage, fixed, units } = {}) {
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
  drawContent(ctx, d, { zoom: z, dark: false, underlayImage, units });
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
  for (const sg of inkSegments(p)) out += sg.q ? `Q${f(sg.q[0])} ${f(sg.q[1])} ${f(sg.to[0])} ${f(sg.to[1])}` : `L${f(sg.to[0])} ${f(sg.to[1])}`;
  return out;
}

const f2 = (n) => Math.round(n * 100) / 100;
const svgPoly = (pts) => `M${pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join('L')}Z`;

/** SVG for one room: floor, walls with door gaps, fixtures, name and dimensions. */
function roomSVG(room, d, units) {
  if (!room.points || room.points.length < 3) return '';
  const geo = roomGeo(room, d);
  const out = [`<g data-room="${escX(room.name || '')}">`, `<path d="${svgPoly(room.points)}" fill="${ROOM_TINT[room.type] || ROOM_TINT.other}" fill-opacity="0.07"/>`];
  for (const f of room.features || []) {
    if (['door', 'opening', 'window'].includes(f.kind)) continue;
    const c = featureCorners(geo, f);
    if (c) out.push(`<path d="${svgPoly(c)}" fill="#1c1b19" fill-opacity="0.05" stroke="#7a756b" stroke-width="1.2"/>`);
  }
  const walls = wallPieces(geo, room).map(([i, a, b]) => {
    const p = wallPoint(geo, i, a, -0.04), q = wallPoint(geo, i, b, -0.04);
    return `M${f2(p[0])} ${f2(p[1])}L${f2(q[0])} ${f2(q[1])}`;
  }).join('');
  out.push(`<path d="${walls}" fill="none" stroke="#3d3a35" stroke-width="4"/>`);
  for (const f of (room.features || []).filter((x) => x.kind === 'window')) {
    const sp = featureSpan(geo, f);
    if (!sp) continue;
    const p = wallPoint(geo, f.wall, sp.a, -0.04), q = wallPoint(geo, f.wall, sp.b, -0.04);
    out.push(`<path d="M${f2(p[0])} ${f2(p[1])}L${f2(q[0])} ${f2(q[1])}" stroke="#1f5fb8" stroke-width="2"${f.toFloor ? ' stroke-dasharray="3 2"' : ''}/>`);
  }
  for (const f of (room.features || []).filter((x) => x.kind === 'door')) {
    const sp = featureSpan(geo, f);
    if (!sp) continue;
    const hingeT = f.hinge === 'end' ? sp.b : sp.a, latchT = f.hinge === 'end' ? sp.a : sp.b;
    const hp = wallPoint(geo, f.wall, hingeT, 0), lp = wallPoint(geo, f.wall, latchT, 0);
    const leaf = wallPoint(geo, f.wall, hingeT, (f.swing === 'out' ? -1 : 1) * (sp.b - sp.a));
    const r = (sp.b - sp.a) * geo.ppm;
    const cross = (leaf[0] - hp[0]) * (lp[1] - hp[1]) - (leaf[1] - hp[1]) * (lp[0] - hp[0]);
    out.push(`<path d="M${f2(hp[0])} ${f2(hp[1])}L${f2(leaf[0])} ${f2(leaf[1])}" stroke="#3d3a35" stroke-width="1.1"/>`,
      `<path d="M${f2(leaf[0])} ${f2(leaf[1])}A${f2(r)} ${f2(r)} 0 0 ${cross > 0 ? 1 : 0} ${f2(lp[0])} ${f2(lp[1])}" fill="none" stroke="#3d3a35" stroke-width="1.1" stroke-dasharray="3 3"/>`);
  }
  const font = 'font-family="Inter, system-ui, sans-serif" text-anchor="middle" dominant-baseline="central"';
  for (const w of geo.walls) {
    if (w.lenM < 0.5) continue;
    const [x, y] = wallPoint(geo, w.i, w.lenM / 2, -16 / geo.ppm);
    let ang = (w.angle * 180) / Math.PI;
    if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
    out.push(`<text x="${f2(x)}" y="${f2(y)}" transform="rotate(${f2(ang)} ${f2(x)} ${f2(y)})" ${font} font-size="9" font-weight="600" fill="#7a756b">${escX(fmtLength(w.lenM, { units, denom: 2 }))}</text>`);
  }
  const [lx, ly] = geo.label;
  const typeLabel = ROOM_TYPES[room.type]?.label || 'Room';
  out.push(`<text x="${f2(lx)}" y="${f2(ly - 7)}" ${font} font-size="13" font-weight="700" fill="#3d3a35">${escX(room.name || typeLabel)}</text>`,
    `<text x="${f2(lx)}" y="${f2(ly + 8)}" ${font} font-size="10" fill="#7a756b">${escX(`${typeLabel} · ${roomSizeLabel(room, d, units)}`)}</text>`, '</g>');
  return out.join('');
}

/** Vector export. Pressure strokes use their average width. */
export function toSVG(d, { units = getUnits() } = {}) {
  const pad = 40;
  const b = contentBounds(d) || { x0: 0, y0: 0, x1: 400, y1: 300 };
  const x = b.x0 - pad, y = b.y0 - pad, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">`,
    `<title>${escX(d.name || 'Drawing')}</title>`, `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${LIGHT_PAPER.bg}"/>`];
  if (d.underlay && d.underlayW) out.push(`<image href="${d.underlay}" x="${d.underlayX || 0}" y="${d.underlayY || 0}" width="${d.underlayW}" height="${d.underlayH}" opacity="${d.underlayOpacity ?? 1}"/>`);
  for (const layer of d.layers) {
    if (layer.visible === false) continue;
    out.push(`<g id="${escX(layer.name)}" opacity="${layer.opacity ?? 1}">`);
    for (const r of (d.rooms || []).filter((q) => q.layer === layer.id)) out.push(roomSVG(r, d, units));
    for (const s of d.strokes.filter((q) => q.layer === layer.id)) {
      const avgP = s.points.reduce((a, q) => a + (q[2] ?? 0.5), 0) / s.points.length;
      const width = s.tool === 'pen' ? s.size * (0.3 + 0.7 * avgP) : s.tool === 'pencil' ? s.size * (0.55 + 0.45 * avgP) : s.tool === 'measure' ? 1.5 : s.size;
      const op = (s.opacity ?? 1) * (s.tool === 'highlighter' ? 0.38 : s.tool === 'pencil' ? 0.85 : 1);
      const dash = s.dash ? ` stroke-dasharray="${s.size * 4} ${s.size * 3}"` : '';
      out.push(`<path d="${svgPathFor(s)}" fill="none" stroke="${s.color}" stroke-width="${Math.round(width * 100) / 100}" stroke-opacity="${op}" stroke-linecap="${s.tool === 'highlighter' ? 'butt' : 'round'}" stroke-linejoin="round"${dash}/>`);
      if (s.tool === 'measure' && d.scale > 0) {
        const [a, c] = [s.points[0], s.points[s.points.length - 1]];
        out.push(`<text x="${(a[0] + c[0]) / 2}" y="${(a[1] + c[1]) / 2 - 6}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle" fill="${s.color}">${escX(fmtWorldLength(segLen(a, c), d, units))}</text>`);
      }
    }
    for (const o of d.objects.filter((q) => q.layer === layer.id)) {
      out.push(`<g transform="translate(${o.x} ${o.y}) rotate(${o.rotation || 0}) scale(${o.scale || 1})">${symbolSVG(o.symbol, o.color || '#1c1b19')}</g>`);
      const tags = deviceTags(o);
      if (tags) out.push(`<text x="${f2(o.x + 13 * (o.scale || 1))}" y="${f2(o.y - 13 * (o.scale || 1))}" font-family="Inter, system-ui, sans-serif" font-size="${7 * (o.scale || 1)}" font-weight="700" fill="${o.color || '#1c1b19'}" dominant-baseline="central">${tags}</text>`);
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
