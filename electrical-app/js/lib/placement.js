// Room geometry and auto-placement of boxes. Pure functions, no DOM, so they
// run in Node tests and in the canvas alike.
//
// A room lives in `drawing.rooms[]`:
//   { id, layer, name, type, points: [[x, y], ...] (world px, the inside face
//     of the walls), features: [...], lighting?, carSpaces?, aboveGradeM? }
// Wall i runs from points[i] to points[i + 1]. A wall feature sits on wall
// `wall` from `atM` to `atM + widthM` metres (from that wall's start corner)
// and reaches `depthM` into the room. Islands are free-standing:
//   { kind: 'island', x, y (world px centre), lengthM, depthM, rotation (deg), peninsula?, sink?, fixed? }
// The drawing's `scale` is world px per foot; every stored length is metres.
import {
  RULES, ROOM_TYPES, FEATURE_KINDS, WET_KINDS, RECEPTACLE_SYMBOLS, SWITCH_SYMBOLS,
  LIGHT_SYMBOLS, ALARM_SYMBOLS, placementSettings,
} from './placement-rules.js';

export const M_PER_FT = 0.3048;
const EPS = 1e-6;

/** World px per metre for a drawing scale (px per foot). */
export const pxPerM = (scale) => (Number(scale) > 0 ? Number(scale) : 24) / M_PER_FT;

// ---------- polygons ----------
/** Signed shoelace area in px² (positive for clockwise-on-screen, y down). */
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function polyCentroid(pts) {
  const A = polyArea(pts);
  if (Math.abs(A) < EPS) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyBounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

/** Distance from a point to a segment, and where along it (0..1). */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/** Rectangle room from two opposite corners (clockwise on screen). */
export function rectPoints(a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// ---------- walls ----------
/**
 * Geometry of a room at a scale: walls with unit direction `u`, inward normal
 * `n`, length in metres and perimeter start `s0` (metres), plus perimeter P.
 */
export function roomGeometry(room, ppm) {
  const pts = room.points;
  const sign = polyArea(pts) >= 0 ? 1 : -1;
  const walls = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenPx = Math.hypot(dx, dy) || EPS;
    const u = [dx / lenPx, dy / lenPx];
    const n = sign > 0 ? [-u[1], u[0]] : [u[1], -u[0]];
    walls.push({ i, a, b, u, n, lenPx, lenM: lenPx / ppm, angle: Math.atan2(dy, dx), s0: s });
    s += lenPx / ppm;
  }
  return { room, ppm, walls, P: s, areaM2: Math.abs(polyArea(pts)) / (ppm * ppm), centroid: polyCentroid(pts) };
}

/** World point on wall i, t metres from its start, v metres into the room. */
export function wallPoint(geo, i, t, v = 0) {
  const w = geo.walls[i];
  return [w.a[0] + (w.u[0] * t + w.n[0] * v) * geo.ppm, w.a[1] + (w.u[1] * t + w.n[1] * v) * geo.ppm];
}

/** Wall and offset for a perimeter position s (metres, wraps). */
export function perimeterAt(geo, s) {
  const P = geo.P;
  let q = ((s % P) + P) % P;
  for (const w of geo.walls) {
    if (q <= w.s0 + w.lenM + EPS) return { wall: w.i, t: Math.max(0, Math.min(w.lenM, q - w.s0)) };
  }
  const last = geo.walls[geo.walls.length - 1];
  return { wall: last.i, t: last.lenM };
}

/** World point (inset px into the room) and wall angle for perimeter position s. */
export function perimeterPoint(geo, s, insetPx = 0) {
  const { wall, t } = perimeterAt(geo, s);
  const w = geo.walls[wall];
  const [x, y] = wallPoint(geo, wall, t, insetPx / geo.ppm);
  return { x, y, wall, t, angle: w.angle };
}

/** Wall-local coordinates of a world point: u metres along wall i, v metres inward. */
export function wallLocal(geo, i, x, y) {
  const w = geo.walls[i];
  const dx = (x - w.a[0]) / geo.ppm, dy = (y - w.a[1]) / geo.ppm;
  return { u: dx * w.u[0] + dy * w.u[1], v: dx * w.n[0] + dy * w.n[1] };
}

/** Nearest wall to a world point: { wall, t, dist (m), s }. */
export function projectToWalls(geo, x, y) {
  let best = null;
  for (const w of geo.walls) {
    const r = distToSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]);
    if (!best || r.d < best.dPx) best = { wall: w.i, t: r.t * w.lenM, dPx: r.d };
  }
  if (!best) return null;
  const w = geo.walls[best.wall];
  return { wall: best.wall, t: best.t, dist: best.dPx / geo.ppm, s: w.s0 + best.t };
}

/** Receptacle-friendly rotation for a wall angle: in (-90, 90] degrees. */
export function wallRotation(angle) {
  let deg = Math.round((angle * 180) / Math.PI);
  deg = ((deg % 180) + 180) % 180;
  if (deg > 90) deg -= 180;
  return deg === -0 ? 0 : deg;
}

// ---------- features ----------
/** Clamped span of a wall feature on its wall: { a, b } metres. */
export function featureSpan(geo, f) {
  const w = geo.walls[f.wall];
  if (!w) return null;
  const width = Math.min(w.lenM, Math.max(0.05, Number(f.widthM) || FEATURE_KINDS[f.kind]?.widthM || 0.8));
  const a = Math.max(0, Math.min(w.lenM - width, Number(f.atM) || 0));
  return { a, b: a + width };
}

/** Depth of a wall feature into the room (metres). */
export const featureDepth = (f) => (f.depthM != null ? Number(f.depthM) : FEATURE_KINDS[f.kind]?.depthM || 0);

/** Corners (world px) of an island. */
export function islandCorners(f, ppm) {
  const L = (Number(f.lengthM) || FEATURE_KINDS.island.lengthM) * ppm / 2;
  const D = (Number(f.depthM) || FEATURE_KINDS.island.depthM) * ppm / 2;
  const r = ((Number(f.rotation) || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[-L, -D], [L, -D], [L, D], [-L, D]].map(([x, y]) => [f.x + x * c - y * s, f.y + x * s + y * c]);
}

/** Corners (world px) of any feature's footprint. Doors, openings and windows get a thin strip. */
export function featureCorners(geo, f) {
  if (f.kind === 'island') return islandCorners(f, geo.ppm);
  const sp = featureSpan(geo, f);
  if (!sp) return null;
  const dep = Math.max(featureDepth(f), 0.02);
  return [wallPoint(geo, f.wall, sp.a, 0), wallPoint(geo, f.wall, sp.b, 0), wallPoint(geo, f.wall, sp.b, dep), wallPoint(geo, f.wall, sp.a, dep)];
}

/** Shortest distance (metres) from a world point to a feature's footprint. */
export function distToFeature(geo, f, x, y) {
  if (f.kind === 'island') {
    const r = (-(Number(f.rotation) || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const dx = (x - f.x) / geo.ppm, dy = (y - f.y) / geo.ppm;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    const hx = (Number(f.lengthM) || FEATURE_KINDS.island.lengthM) / 2, hy = (Number(f.depthM) || FEATURE_KINDS.island.depthM) / 2;
    return Math.hypot(Math.max(Math.abs(lx) - hx, 0), Math.max(Math.abs(ly) - hy, 0));
  }
  const sp = featureSpan(geo, f);
  if (!sp) return Infinity;
  const { u, v } = wallLocal(geo, f.wall, x, y);
  const du = Math.max(sp.a - u, 0, u - sp.b);
  const dv = Math.max(-v, 0, v - featureDepth(f));
  return Math.hypot(du, dv);
}

/** Centre of a feature (world px), on the room side of its wall. */
export function featureCentre(geo, f) {
  if (f.kind === 'island') return [f.x, f.y];
  const sp = featureSpan(geo, f);
  return wallPoint(geo, f.wall, (sp.a + sp.b) / 2, featureDepth(f) / 2);
}

/** Wet features (sink, basin, tub, shower, island with a sink) in a room. */
export function wetFeatures(room) {
  return (room.features || []).filter((f) => WET_KINDS.has(f.kind) || (f.kind === 'island' && f.sink));
}

// ---------- intervals on the perimeter ----------
/** Merge intervals on a closed perimeter of length P into sorted, non-wrapping pieces in [0, P]. */
export function normalizeIntervals(list, P) {
  const pieces = [];
  for (let [a, b] of list) {
    if (!(b > a)) continue;
    if (b - a >= P - EPS) return [[0, P]];
    const k = Math.floor(a / P);
    a -= k * P; b -= k * P;
    if (b > P) { pieces.push([a, P], [0, b - P]); } else pieces.push([a, b]);
  }
  pieces.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && p[0] <= last[1] + EPS) last[1] = Math.max(last[1], p[1]);
    else out.push([...p]);
  }
  return out;
}

/** Perimeter intervals that are not usable wall space (26-722 c)). */
export function blockedIntervals(room, geo, settings = {}) {
  const S = placementSettings(settings);
  const list = [];
  for (const f of room.features || []) {
    const kind = FEATURE_KINDS[f.kind];
    if (!kind || kind.free) continue;
    const sp = featureSpan(geo, f);
    if (!sp) continue;
    const w = geo.walls[f.wall];
    const s0 = w.s0 + sp.a, s1 = w.s0 + sp.b;
    const blocks = f.kind === 'window' ? !!f.toFloor : kind.blocks;
    if (blocks) list.push([s0, s1]);
    // the wall a door covers when fully open is not usable wall space
    if (f.kind === 'door' && S.excludeDoorSwing && f.swing !== 'out') {
      const width = s1 - s0;
      list.push(f.hinge === 'end' ? [s1, s1 + width] : [s0 - width, s0]);
    }
  }
  return normalizeIntervals(list, geo.P);
}

/** Usable wall runs: [{ s0, len }] going around the room (s0 + len may pass P). */
export function usableRuns(room, geo, settings) {
  const P = geo.P;
  const blocked = blockedIntervals(room, geo, settings);
  if (!blocked.length) return [{ s0: 0, len: P, closed: true }];
  const runs = [];
  for (let k = 0; k < blocked.length; k++) {
    const end = blocked[k][1];
    const next = k + 1 < blocked.length ? blocked[k + 1][0] : blocked[0][0] + P;
    if (next - end > EPS) runs.push({ s0: end % P, len: next - end });
  }
  return runs;
}

/** Position of perimeter point s relative to a run (may be negative or past the end). */
export function runRel(run, s, P) {
  let r = (((s - run.s0) % P) + P) % P;
  if (r > run.len + (P - run.len) / 2) r -= P; // closer to the run's start from behind
  return r;
}

// ---------- coverage ----------
/**
 * Farthest any point on [0, len] is from the nearest position (positions may
 * lie outside the segment). { max, at } — max is Infinity with no positions.
 */
export function maxDistOnSegment(len, positions) {
  const p = [...positions].sort((a, b) => a - b);
  if (!p.length) return { max: Infinity, at: len / 2 };
  const near = (x) => { let m = Infinity; for (const q of p) m = Math.min(m, Math.abs(x - q)); return m; };
  const cand = [0, len];
  for (let i = 0; i + 1 < p.length; i++) { const m = (p[i] + p[i + 1]) / 2; if (m > 0 && m < len) cand.push(m); }
  let best = { max: -1, at: 0 };
  for (const x of cand) { const d = near(x); if (d > best.max) best = { max: d, at: x }; }
  return best;
}

/**
 * New positions on [0, len] so that, together with `existing`, no point is
 * more than maxD from one. Each gap gets the fewest boxes, evenly spaced.
 */
export function fillCoverage(len, existing, maxD) {
  const cov = existing.map((p) => [Math.max(0, p - maxD), Math.min(len, p + maxD)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const c of cov) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1] + EPS) last[1] = Math.max(last[1], c[1]); else merged.push([...c]);
  }
  const gaps = [];
  let cur = 0;
  for (const [a, b] of merged) { if (a - cur > EPS) gaps.push([cur, a]); cur = Math.max(cur, b); }
  if (len - cur > EPS) gaps.push([cur, len]);
  const out = [];
  for (const [u0, u1] of gaps) {
    const L = u1 - u0;
    const n = Math.max(1, Math.ceil(L / (2 * maxD) - 1e-9));
    for (let k = 0; k < n; k++) out.push(u0 + ((2 * k + 1) * L) / (2 * n));
  }
  return out;
}

/** Move new positions off inside corners when the spacing still holds. */
function nudgeOffCorners(run, geo, fresh, existing, maxD, clear) {
  if (!(clear > 0)) return fresh;
  const corners = geo.walls.map((w) => runRel(run, w.s0, geo.P)).filter((r) => r > EPS && r < run.len - EPS);
  const out = [...fresh];
  for (let j = 0; j < out.length; j++) {
    const c = corners.find((r) => Math.abs(out[j] - r) < clear);
    if (c == null) continue;
    const tries = (out[j] <= c ? [c - clear, c + clear] : [c + clear, c - clear]).filter((x) => x >= 0 && x <= run.len);
    for (const x of tries) {
      const trial = out.map((v, k) => (k === j ? x : v));
      if (maxDistOnSegment(run.len, [...existing, ...trial]).max <= maxD + 1e-9) { out[j] = x; break; }
    }
  }
  return out;
}

// ---------- the model the placer and checker share ----------
const isRec = (o) => RECEPTACLE_SYMBOLS.has(o.symbol);
const isSwitch = (o) => SWITCH_SYMBOLS.has(o.symbol);
const isLight = (o) => LIGHT_SYMBOLS.has(o.symbol);
const isAlarm = (o) => ALARM_SYMBOLS.has(o.symbol);
export const symbolFamily = (sym) => (RECEPTACLE_SYMBOLS.has(sym) ? 'receptacle' : SWITCH_SYMBOLS.has(sym) ? 'switch'
  : LIGHT_SYMBOLS.has(sym) ? 'light' : ALARM_SYMBOLS.has(sym) ? 'alarm' : 'other');
export { isRec, isSwitch, isLight, isAlarm };

/** Symbol inset from the wall line (world px), so boxes sit just inside the room. */
export const insetPx = (ppm) => Math.min(14, 0.25 * ppm);

/**
 * Rooms with geometry, the visible symbols, and which room each symbol is in.
 * Rooms count whether or not their layer is shown; symbols only when visible.
 */
export function buildModel(d, settings) {
  const S = placementSettings(settings);
  const ppm = pxPerM(d.scale);
  const visible = new Set((d.layers || []).filter((l) => l.visible !== false).map((l) => l.id));
  const shown = (lid) => !(d.layers || []).length || lid == null || visible.has(lid);
  const rooms = (d.rooms || [])
    .filter((r) => Array.isArray(r.points) && r.points.length >= 3 && Math.abs(polyArea(r.points)) > EPS)
    .map((room) => ({ room, geo: roomGeometry(room, ppm), type: ROOM_TYPES[room.type] || ROOM_TYPES.other }));
  const objects = (d.objects || []).filter((o) => shown(o.layer));
  const inset = insetPx(ppm);
  const tolM = Math.max(S.wallTolM, (inset + 6) / ppm);
  const byRoom = new Map(rooms.map((r) => [r.room.id, []]));
  for (const o of objects) {
    const rm = roomAt(rooms, o.x, o.y, tolM);
    if (rm) byRoom.get(rm.room.id).push(o);
  }
  return { d, S, ppm, rooms, objects, byRoom, inset, tolM };
}

/** The room a point is in (smallest containing room), or the nearest one within tolM of its wall. */
export function roomAt(rooms, x, y, tolM = 0) {
  let best = null;
  for (const rm of rooms) if (pointInPoly(x, y, rm.room.points) && (!best || rm.geo.areaM2 < best.geo.areaM2)) best = rm;
  if (best || !(tolM > 0)) return best;
  let bd = tolM;
  for (const rm of rooms) {
    const pr = projectToWalls(rm.geo, x, y);
    if (pr && pr.dist <= bd) { bd = pr.dist; best = rm; }
  }
  return best;
}

/** Receptacles in a room that sit on a wall, with their perimeter position. */
export function wallReceptacles(model, rm, objs = model.byRoom.get(rm.room.id) || []) {
  const out = [];
  for (const o of objs) {
    if (!isRec(o)) continue;
    const pr = projectToWalls(rm.geo, o.x, o.y);
    if (pr && pr.dist <= model.tolM) out.push({ o, ...pr });
  }
  return out;
}

/** A point well inside the room: the centroid if inside, else the sample farthest from the walls. */
export function interiorPoint(geo) {
  const pts = geo.room.points;
  const [cx, cy] = geo.centroid;
  const clearance = (x, y) => Math.min(...geo.walls.map((w) => distToSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]).d));
  if (pointInPoly(cx, cy, pts) && clearance(cx, cy) > 0.3 * geo.ppm) return [cx, cy];
  const b = polyBounds(pts);
  const step = Math.max((b.x1 - b.x0) / 24, (b.y1 - b.y0) / 24, 1);
  let best = null, bd = -1;
  for (let x = b.x0 + step / 2; x < b.x1; x += step) {
    for (let y = b.y0 + step / 2; y < b.y1; y += step) {
      if (!pointInPoly(x, y, pts)) continue;
      const c = clearance(x, y) - 0.05 * Math.hypot(x - cx, y - cy); // prefer near the middle
      if (c > bd) { bd = c; best = [x, y]; }
    }
  }
  return best || [cx, cy];
}

/** Grid of points inside a room, aligned with its longest wall, `spacingM` apart. */
export function gridPoints(geo, spacingM, { minWallM = 0.3 } = {}) {
  const pts = geo.room.points;
  const longest = geo.walls.reduce((a, w) => (w.lenM > a.lenM ? w : a), geo.walls[0]);
  const [ux, uy] = longest.u, [nx, ny] = [-uy, ux];
  const [cx, cy] = geo.centroid;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of pts) {
    const u = ((x - cx) * ux + (y - cy) * uy) / geo.ppm, v = ((x - cx) * nx + (y - cy) * ny) / geo.ppm;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const cols = Math.max(1, Math.round((u1 - u0) / spacingM)), rows = Math.max(1, Math.round((v1 - v0) / spacingM));
  const out = [];
  const clear = Math.min(minWallM, spacingM / 3) * geo.ppm;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const u = u0 + ((i + 0.5) * (u1 - u0)) / cols, v = v0 + ((j + 0.5) * (v1 - v0)) / rows;
      const x = cx + (u * ux + v * nx) * geo.ppm, y = cy + (u * uy + v * ny) * geo.ppm;
      if (!pointInPoly(x, y, pts)) continue;
      const wallD = Math.min(...geo.walls.map((w) => distToSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]).d));
      if (wallD < clear) continue;
      out.push([x, y]);
    }
  }
  return out.length ? out : [interiorPoint(geo)];
}

/** Sample points inside a room every `stepM` metres (for reach checks). */
export function samplePoints(geo, stepM = 0.3) {
  const pts = geo.room.points;
  const b = polyBounds(pts);
  const step = stepM * geo.ppm;
  const out = [];
  for (let x = b.x0 + step / 2; x < b.x1; x += step) for (let y = b.y0 + step / 2; y < b.y1; y += step) if (pointInPoly(x, y, pts)) out.push([x, y]);
  if (!out.length) out.push(interiorPoint(geo));
  return out;
}

// ---------- receptacle flags ----------
/** Distance (m) from a point to the nearest wet feature in the room, or Infinity. */
export function nearestWet(geo, room, x, y) {
  let best = Infinity;
  for (const f of wetFeatures(room)) best = Math.min(best, distToFeature(geo, f, x, y));
  return best;
}

/**
 * Protection a receptacle needs at a point: GFCI (26-704), AFCI (26-658, with
 * the kitchen counter, fridge, island and peninsula exemptions), TR (26-706),
 * weatherproof cover outdoors (26-708).
 */
export function receptacleNeeds(rm, x, y, { exemptAfci = false } = {}) {
  const outdoorGfci = !!rm.type.outdoor && !((Number(rm.room.aboveGradeM) || 0) > RULES.gfciOutdoor.gradeM);
  const wet = nearestWet(rm.geo, rm.room, x, y) <= RULES.gfciWet.withinM;
  return { gfci: wet || outdoorGfci, afci: !exemptAfci, tr: true, wp: !!rm.type.outdoor };
}

// ---------- auto-place ----------
/**
 * Proposed boxes for one room. Existing symbols in the room are respected: wall
 * runs and counters are only filled where they fall short, and switches,
 * lights and alarms are skipped where one is already there.
 * Each proposal: { id, roomId, symbol, x, y, rotation, flags, mountM, ruleRefs, reason, group }.
 */
export function proposeRoom(d, roomId, { settings, codeOptions = {}, model } = {}) {
  model ||= buildModel(d, settings);
  const rm = model.rooms.find((r) => r.room.id === roomId);
  if (!rm) return [];
  const S = model.S;
  const { room, geo, type } = rm;
  const ppm = geo.ppm, inset = model.inset;
  const objs = model.byRoom.get(room.id) || [];
  const out = [];
  const recPts = objs.filter(isRec).map((o) => [o.x, o.y]); // existing + proposed receptacles
  const add = (p) => {
    const q = { id: `${room.id}:${out.length}`, roomId: room.id, rotation: 0, scale: 1, flags: {}, ruleRefs: [], ...p };
    out.push(q);
    if (RECEPTACLE_SYMBOLS.has(q.symbol)) recPts.push([q.x, q.y]);
    return q;
  };
  const recSymbol = (flags) => (flags.gfci ? 'receptacle-gfci' : 'receptacle');
  const addRec = (x, y, { rotation = 0, exemptAfci = false, mountM = S.receptacleHeightM, rules, reason, extra = {} }) => {
    const flags = { ...receptacleNeeds(rm, x, y, { exemptAfci }), ...extra };
    const refs = [...rules];
    if (flags.gfci) refs.push(type.outdoor ? 'gfciOutdoor' : 'gfciWet');
    if (flags.wp) refs.push('weather');
    return add({ symbol: recSymbol(flags), x, y, rotation, flags, mountM, ruleRefs: refs, reason, group: 'receptacle' });
  };
  const recNear = (x, y, withinM) => recPts.some(([px, py]) => Math.hypot(px - x, py - y) / ppm <= withinM);
  const recNearFeature = (f, withinM) => recPts.some(([px, py]) => distToFeature(geo, f, px, py) <= withinM);
  const runAt = (s, runs) => runs.find((r) => { const q = runRel(r, s, geo.P); return q >= -EPS && q <= r.len + EPS; });

  const features = room.features || [];
  const runs = usableRuns(room, geo, S);
  const longestRun = () => runs.reduce((a, r) => (!a || r.len > a.len ? r : a), null);
  const runPoint = (run, rel) => perimeterPoint(geo, run.s0 + rel, inset);

  // 1) kitchen counters, islands, fridge and range: 26-722 d)
  if (type.kitchen) {
    const maxD = RULES.counter.maxM;
    for (const c of features.filter((f) => f.kind === 'counter')) {
      const sp = featureSpan(geo, c);
      if (!sp) continue;
      const holes = features.filter((f) => f !== c && f.wall === c.wall && ['sink', 'cooktop', 'range'].includes(f.kind)).map((f) => featureSpan(geo, f)).filter(Boolean);
      const segs = subtractSpans(sp, holes).filter(([a, b]) => b - a >= RULES.counter.minSegmentM - EPS);
      // only boxes on this counter count (a low box past its end does not serve it)
      const wallRecs = () => recPts.map(([x, y]) => wallLocal(geo, c.wall, x, y))
        .filter((q) => q.v <= featureDepth(c) + 0.05 && q.v >= -model.tolM && q.u >= sp.a - 0.05 && q.u <= sp.b + 0.05).map((q) => q.u);
      for (const [a, b] of segs) {
        const fresh = fillCoverage(b - a, wallRecs().map((u) => u - a), maxD);
        for (const r of fresh) {
          const [x, y] = wallPoint(geo, c.wall, a + r, inset / ppm);
          addRec(x, y, { rotation: wallRotation(geo.walls[c.wall].angle), exemptAfci: true, mountM: S.counterHeightM, rules: ['counter', 'tamper'],
            reason: 'Counter: no point on the wall line more than 900 mm from a receptacle (5-15R split or 5-20R)', extra: { counter: true } });
        }
      }
    }
    for (const f of features.filter((q) => q.kind === 'island')) {
      const L = Math.max(Number(f.lengthM) || 0, Number(f.depthM) || 0), D = Math.min(Number(f.lengthM) || 0, Number(f.depthM) || 0);
      const rule = f.peninsula ? 'peninsula' : 'island';
      if (f.fixed === false || L < RULES[rule].minLongM - EPS || D < RULES[rule].minShortM - EPS) continue;
      if (recNearFeature(f, 0.3)) continue;
      // centre of a long side, on the side face
      const corners = islandCorners(f, ppm);
      const long = (Number(f.lengthM) || 0) >= (Number(f.depthM) || 0);
      const [p, q] = long ? [corners[2], corners[3]] : [corners[1], corners[2]];
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      const ox = mx - f.x, oy = my - f.y, ol = Math.hypot(ox, oy) || 1;
      const x = mx + (ox / ol) * 6, y = my + (oy / ol) * 6;
      const q2 = addRec(x, y, { rotation: wallRotation(Math.atan2(q[1] - p[1], q[0] - p[0])), exemptAfci: true, mountM: S.counterHeightM - 0.2,
        rules: [rule, 'islandSide', 'tamper'], reason: `${f.peninsula ? 'Peninsula' : 'Island'} counter: at least one receptacle (side face, not more than 300 mm below the top)`, extra: { counter: true } });
      if (f.sink && !q2.flags.gfci) { q2.flags.gfci = true; q2.symbol = 'receptacle-gfci'; q2.ruleRefs.push('gfciWet'); }
    }
    for (const f of features.filter((q) => q.kind === 'fridge')) {
      if (recNearFeature(f, RULES.fridge.withinM)) continue;
      const sp = featureSpan(geo, f);
      const [x, y] = wallPoint(geo, f.wall, (sp.a + sp.b) / 2, inset / ppm);
      addRec(x, y, { rotation: wallRotation(geo.walls[f.wall].angle), exemptAfci: true, mountM: S.applianceHeightM, rules: ['fridge', 'tamper'],
        reason: 'Refrigerator receptacle (own branch circuit, 26-654)', extra: { dedicated: true } });
    }
    for (const f of features.filter((q) => q.kind === 'range')) {
      const sp = featureSpan(geo, f);
      const [x, y] = wallPoint(geo, f.wall, (sp.a + sp.b) / 2, inset / ppm);
      if (f.gas) {
        if (recNearFeature(f, RULES.gasRange.withinM)) continue;
        addRec(x, y, { rotation: wallRotation(geo.walls[f.wall].angle), mountM: RULES.gasRange.maxHeightM, rules: ['gasRange', 'tamper', 'afci'],
          reason: 'Gas range: receptacle behind the range, centre not over 130 mm above the floor' });
      } else if (!objs.some((o) => o.symbol === 'receptacle-240' && distToFeature(geo, f, o.x, o.y) <= 0.6)) {
        add({ symbol: 'receptacle-240', x, y, rotation: wallRotation(geo.walls[f.wall].angle), flags: {}, mountM: RULES.gasRange.maxHeightM,
          ruleRefs: [], reason: 'Electric range receptacle (14-50R) behind the range', group: 'receptacle' });
      }
    }
  }

  // 2) usable wall, 26-722 a) and c) (kitchens: d) vi) for the walls without counters).
  //    After the kitchen boxes, so a low wall box never stands in for the fridge's.
  if (type.wallRule) {
    const maxD = RULES.wallSpacing.maxM;
    const onWall = () => recPts.map(([x, y]) => projectToWalls(geo, x, y)).filter((p) => p && p.dist <= model.tolM);
    for (const run of runs) {
      if (run.len < RULES.usableWall.minM - EPS) continue; // a 600 mm stub is not usable wall space
      const rel = onWall().map((p) => runRel(run, p.s, geo.P)).filter((r) => r >= -0.05 && r <= run.len + 0.05).map((r) => Math.max(0, Math.min(run.len, r)));
      let fresh = fillCoverage(run.len, rel, maxD);
      fresh = nudgeOffCorners(run, geo, fresh, rel, maxD, S.cornerClearM);
      for (const r of fresh) {
        const p = runPoint(run, r);
        addRec(p.x, p.y, { rotation: wallRotation(p.angle), rules: [type.kitchen ? 'kitchenWalls' : 'wallSpacing', 'usableWall', 'tamper', 'afci'],
          reason: 'Usable wall: no point along the floor line more than 1.8 m from a receptacle' });
      }
    }
  }

  // 3) bathrooms: a receptacle near each basin, away from the tub or shower: 26-720 f), g); GFCI 26-704
  if (type.bathroom) {
    const tubs = features.filter((f) => f.kind === 'tub' || f.kind === 'shower');
    const tubDist = (x, y) => tubs.reduce((m, f) => Math.min(m, distToFeature(geo, f, x, y)), Infinity);
    for (const basin of features.filter((f) => f.kind === 'sink')) {
      if (recNearFeature(basin, RULES.basin.withinM)) continue;
      const sp = featureSpan(geo, basin);
      const w = geo.walls[basin.wall];
      const cands = [];
      for (const off of [0.15, 0.3, 0.5, 0.7]) for (const t of [sp.a - off, sp.b + off]) if (t >= 0.1 && t <= w.lenM - 0.1) cands.push(t);
      let best = null;
      for (const t of cands) {
        const [x, y] = wallPoint(geo, basin.wall, t, inset / ppm);
        const bd = distToFeature(geo, basin, x, y), td = tubDist(x, y);
        if (bd > RULES.basin.withinM) continue;
        const score = (td >= RULES.tub.preferM ? 2 : td >= RULES.tub.minM ? 1 : 0) * 10 - bd;
        if (!best || score > best.score) best = { x, y, score, td };
      }
      if (!best) continue;
      const q = addRec(best.x, best.y, { rotation: wallRotation(w.angle), mountM: S.counterHeightM, rules: ['basin', 'tub', 'tamper', 'afci'],
        reason: best.td < RULES.tub.preferM ? 'Basin receptacle; the tub or shower is closer than 1 m, move it if you can' : 'Basin receptacle, at least 1 m from the tub or shower' });
      q.flags.gfci = true; q.symbol = 'receptacle-gfci';
      if (!q.ruleRefs.includes('gfciWet')) q.ruleRefs.push('gfciWet');
    }
  }

  // 4) laundry: washer receptacle + one more, 26-720 e) i), ii)
  if (type.laundry) {
    for (const f of features.filter((q) => q.kind === 'washer')) {
      if (recNearFeature(f, RULES.laundry.withinM)) continue;
      const sp = featureSpan(geo, f);
      const [x, y] = wallPoint(geo, f.wall, (sp.a + sp.b) / 2, inset / ppm);
      addRec(x, y, { rotation: wallRotation(geo.walls[f.wall].angle), mountM: S.applianceHeightM, rules: ['laundry', 'tamper', 'afci'], reason: 'Washing machine receptacle' });
    }
    const washers = features.filter((q) => q.kind === 'washer').length;
    const need = washers + 1 - recPts.length;
    const run = longestRun();
    if (need > 0 && run) {
      for (let k = 0; k < need; k++) {
        const p = runPoint(run, ((k + 0.5) * run.len) / need);
        addRec(p.x, p.y, { rotation: wallRotation(p.angle), rules: ['laundry', 'tamper', 'afci'], reason: 'Laundry room: at least one receptacle besides the washer' });
      }
    }
  }

  // 5) unfinished basement 26-720 e) iv); garage 26-724 b); balcony/outdoor 26-722 b), 26-724 a)
  const minimum = (n, rules, reason, preferDoorWall) => {
    let need = n - recPts.length;
    if (need <= 0 || !runs.length) return;
    const run = longestRun();
    const door = preferDoorWall && features.find((f) => f.kind === 'door' && geo.walls[f.wall]);
    if (door) {
      // outdoors the receptacle goes on the house wall: the longest free stretch of the door's wall
      const w = geo.walls[door.wall];
      let best = null, cur = null;
      for (let t = 0; t <= w.lenM + 1e-9; t += 0.02) {
        if (runAt(w.s0 + t, runs)) { cur ||= { a: t, b: t }; cur.b = t; if (!best || cur.b - cur.a > best.b - best.a) best = cur; } else cur = null;
      }
      if (best && best.b - best.a >= 0.1) {
        const p = perimeterPoint(geo, w.s0 + (best.a + best.b) / 2, inset);
        addRec(p.x, p.y, { rotation: wallRotation(p.angle), rules: [...rules, 'tamper', 'afci'], reason });
        need--;
      }
    }
    for (let k = 0; k < need; k++) {
      const p = runPoint(run, ((k + 0.5) * run.len) / need);
      addRec(p.x, p.y, { rotation: wallRotation(p.angle), rules: [...rules, 'tamper', 'afci'], reason });
    }
  };
  if (type.basement) minimum(1, ['basement'], 'Unfinished basement: at least one receptacle');
  if (type.garage) minimum(carSpaces(room, geo), ['garage'], 'Garage or carport: a receptacle for each car space');
  if (type.outdoor) minimum(1, ['balcony', 'outdoorSingle'], 'Outdoor / balcony receptacle', true);

  // 6) hallways: no point more than 4.5 m from a receptacle, 26-722 g)
  if (type.hallway) {
    const maxD = RULES.hallway.maxM * ppm;
    const samples = samplePoints(geo, 0.3);
    const farthest = () => {
      let best = null, bd = -1;
      for (const [x, y] of samples) {
        const d0 = recPts.reduce((m, [px, py]) => Math.min(m, Math.hypot(px - x, py - y)), Infinity);
        if (d0 > bd) { bd = d0; best = [x, y]; }
      }
      return { pt: best, d: bd };
    };
    for (let guard = 0; guard < 12; guard++) {
      const f = recPts.length ? farthest() : { pt: geo.centroid, d: Infinity };
      if (f.d <= maxD + EPS || !runs.length) break;
      const pr = projectToWalls(geo, f.pt[0], f.pt[1]);
      let run = runAt(pr.s, runs), rel;
      if (run) rel = Math.max(0.15, Math.min(run.len - 0.15, runRel(run, pr.s, geo.P)));
      else {
        // nearest end of any run
        let best = null;
        for (const r of runs) for (const e of [0.15, r.len - 0.15]) {
          const pp = runPoint(r, Math.max(0, Math.min(r.len, e)));
          const dd = Math.hypot(pp.x - f.pt[0], pp.y - f.pt[1]);
          if (!best || dd < best.dd) best = { r, e: Math.max(0, Math.min(r.len, e)), dd };
        }
        run = best.r; rel = best.e;
      }
      const p = runPoint(run, rel);
      if (recNear(p.x, p.y, 0.3)) break;
      addRec(p.x, p.y, { rotation: wallRotation(p.angle), rules: ['hallway', 'tamper', 'afci'], reason: 'Hallway: no point more than 4.5 m from a receptacle' });
    }
  }

  // 7) switches on the latch side of each entry (company practice; 3-way with two or more entries)
  if (!type.outdoor) {
    const entries = features.filter((f) => (f.kind === 'door' && f.entry !== false) || (f.kind === 'opening' && f.entry === true));
    const symbol = entries.length >= 2 && S.threeWay ? 'switch-3way' : 'switch';
    for (const f of entries) {
      const pt = latchSwitchPoint(geo, f, S.switchFromJambM, inset);
      if (!pt) continue;
      if (objs.some((o) => isSwitch(o) && Math.hypot(o.x - pt.x, o.y - pt.y) / ppm <= 0.6)) continue;
      add({ symbol, x: pt.x, y: pt.y, rotation: 0, flags: {}, mountM: S.switchHeightM, group: 'switch',
        ruleRefs: symbol === 'switch-3way' ? ['latchSwitch', 'threeWay', 'lighting'] : ['latchSwitch', 'lighting'],
        reason: `Switch on the latch side of the ${f.kind === 'door' ? 'door' : 'opening'}, ${Math.round(S.switchHeightM * 1000)} mm to centre (company setting)` });
    }
  }

  // 8) lighting
  const mode = room.lighting || type.light;
  const lightPts = [];
  if (mode !== 'none' && mode !== 'switched-receptacle' && !objs.some(isLight)) {
    if (mode === 'recessed') {
      for (const [x, y] of gridPoints(geo, S.recessedSpacingM)) lightPts.push(add({ symbol: 'light-recessed', x, y, group: 'light', ruleRefs: ['lighting'], reason: `Recessed lights about ${S.recessedSpacingM} m apart` }));
    } else if (mode === 'wall') {
      for (const f of features.filter((q) => q.kind === 'door')) {
        const pt = latchSwitchPoint(geo, f, 0.3, inset);
        if (pt) lightPts.push(add({ symbol: 'light-wall', x: pt.x, y: pt.y, group: 'light', ruleRefs: [], reason: 'Wall light beside the door' }));
      }
    } else if (type.hallway) {
      for (const [x, y] of gridPoints(geo, S.hallLightSpacingM)) lightPts.push(add({ symbol: 'light-ceiling', x, y, group: 'light', ruleRefs: ['lighting'], reason: 'Hallway lighting outlet' }));
    } else {
      const [x, y] = interiorPoint(geo);
      lightPts.push(add({ symbol: 'light-ceiling', x, y, group: 'light', ruleRefs: ['lighting'], reason: 'Lighting outlet controlled by a wall switch' }));
    }
  }

  // 9) smoke / CO alarms (building code, switched by settings)
  const wantSmoke = (type.sleeping && S.alarms.bedrooms) || (type.hallway && S.alarms.hallways) || (type.basement && S.alarms.basement);
  if (wantSmoke && !objs.some(isAlarm)) {
    const co = !!codeOptions.fuelBurning && (type.sleeping || type.hallway);
    let [x, y] = interiorPoint(geo);
    const door = features.find((f) => f.kind === 'door');
    if (door) {
      const [dx, dy] = featureCentre(geo, { ...door, depthM: 0.6 });
      const tx = x + (dx - x) * 0.45, ty = y + (dy - y) * 0.45;
      if (pointInPoly(tx, ty, room.points)) { x = tx; y = ty; }
    }
    for (const l of lightPts) {
      if (Math.hypot(l.x - x, l.y - y) / ppm < 0.5) {
        const w = geo.walls[0];
        x += w.u[0] * 0.6 * ppm; y += w.u[1] * 0.6 * ppm;
        break;
      }
    }
    add({ symbol: 'smoke', x, y, group: 'alarm', flags: { smoke: true, co }, ruleRefs: co ? ['smoke', 'co'] : ['smoke'],
      reason: co ? 'Smoke / CO alarm (building code; fuel-burning appliance or attached garage)' : 'Smoke alarm (building code)' });
  }

  return out;
}

/** Proposals for every room in the drawing. */
export function proposeAll(d, opts = {}) {
  const model = opts.model || buildModel(d, opts.settings);
  return model.rooms.flatMap((rm) => proposeRoom(d, rm.room.id, { ...opts, model }));
}

/** [a, b] minus a list of spans, as sorted pieces. */
export function subtractSpans(span, holes) {
  let pieces = [[span.a, span.b]];
  for (const h of holes) {
    const next = [];
    for (const [a, b] of pieces) {
      if (h.b <= a || h.a >= b) { next.push([a, b]); continue; }
      if (h.a > a) next.push([a, h.a]);
      if (h.b < b) next.push([h.b, b]);
    }
    pieces = next;
  }
  return pieces.filter(([a, b]) => b - a > EPS);
}

/** Garage car spaces: the room's setting, else about one per 3 m of the longest wall. */
export function carSpaces(room, geo) {
  if (Number(room.carSpaces) > 0) return Math.round(Number(room.carSpaces));
  const longest = Math.max(...geo.walls.map((w) => w.lenM));
  return Math.max(1, Math.floor(longest / 3));
}

/**
 * Where the switch for a door goes: on the latch side (opposite the hinge),
 * `fromJambM` past the jamb, inset into the room. Wraps round a corner.
 */
export function latchSwitchPoint(geo, f, fromJambM, inset = 0) {
  const sp = featureSpan(geo, f);
  if (!sp) return null;
  const w = geo.walls[f.wall];
  const latchAtEnd = f.kind === 'door' ? f.hinge !== 'end' : true;
  const s = latchAtEnd ? w.s0 + sp.b + fromJambM : w.s0 + sp.a - fromJambM;
  return { ...perimeterPoint(geo, s, inset), latchS: latchAtEnd ? w.s0 + sp.b : w.s0 + sp.a };
}
