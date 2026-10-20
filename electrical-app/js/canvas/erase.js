// The eraser, kept free of the DOM so it can be tested. Each eraser move sweeps a capsule: the
// eraser circle dragged from the previous sample to this one, so a fast swipe misses nothing.
//   area mode: a stroke loses only what lies inside the capsule. Its polyline is cut where it
//              crosses the capsule's edge (cut points interpolated, pressure too) and the pieces
//              outside stay as strokes of their own, every other field copied (by/at included).
//              The first piece keeps the stroke's id; the others get new ids and splitFrom (the
//              original's id), which drawing-collab.js uses to count the cut as one edit.
//   stroke mode: anything the capsule touches goes, whole (the old behaviour).
// Shapes that can't be cut into pieces of themselves (rectangles, measures, wires) always go whole.
// Long strokes stay fast: a bounding-box check per stroke, then per chunk of 64 segments.

/** Tools whose strokes are cut into pieces in area mode. */
export const SPLIT_TOOLS = new Set(['pen', 'pencil', 'marker', 'highlighter', 'brush', 'line']);
const CHUNK = 64;
const EPS = 1e-9;

/** Distance from point p to segment ab. */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
/** Distance between segments pq and ab (0 when they cross). */
export function segSegDist(px, py, qx, qy, ax, ay, bx, by) {
  const d1 = cross(px, py, qx, qy, ax, ay), d2 = cross(px, py, qx, qy, bx, by);
  const d3 = cross(ax, ay, bx, by, px, py), d4 = cross(ax, ay, bx, by, qx, qy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSeg(px, py, ax, ay, bx, by), distToSeg(qx, qy, ax, ay, bx, by), distToSeg(ax, ay, px, py, qx, qy), distToSeg(bx, by, px, py, qx, qy));
}

/**
 * The part of segment p→q (t in 0..1) inside the capsule of radius r around a→b, as [t0, t1],
 * or null. The capsule is convex, so the part inside is one interval.
 */
export function capsuleInterval(p, q, a, b, r) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let lo = Infinity, hi = -Infinity;
  const add = (t0, t1) => { if (t1 > t0) { if (t0 < lo) lo = t0; if (t1 > hi) hi = t1; } };
  // the end circles
  for (const c of [a, b]) {
    const fx = p[0] - c[0], fy = p[1] - c[1];
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    if (A < EPS) { if (C <= 0) add(0, 1); continue; }
    const disc = B * B - 4 * A * C;
    if (disc <= 0) continue;
    const s = Math.sqrt(disc);
    add((-B - s) / (2 * A), (-B + s) / (2 * A));
  }
  // the band between them: 0 <= u <= len along a→b, |v| <= r across it
  const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
  if (len > EPS) {
    const ux = ex / len, uy = ey / len;
    const u0 = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy, du = dx * ux + dy * uy;
    const v0 = -(p[0] - a[0]) * uy + (p[1] - a[1]) * ux, dv = -dx * uy + dy * ux;
    let t0 = -Infinity, t1 = Infinity;
    const clip = (s0, ds, min, max) => {
      if (Math.abs(ds) < EPS) return s0 >= min && s0 <= max;
      let ta = (min - s0) / ds, tb = (max - s0) / ds;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      return t0 <= t1;
    };
    if (clip(u0, du, 0, len) && clip(v0, dv, -r, r)) add(t0, t1);
  }
  if (hi <= lo) return null;
  const t0 = Math.max(0, lo), t1 = Math.min(1, hi);
  return t1 - t0 > EPS ? [t0, t1] : null;
}

const lerpPt = (p, q, t) => {
  if (t <= 0) return [...p];
  if (t >= 1) return [...q];
  return p.map((v, i) => (typeof v === 'number' && typeof q[i] === 'number' ? v + (q[i] - v) * t : v));
};

// ---- bounds: whole stroke and 64-segment chunks, cached per points array ----
const chunkCache = new WeakMap();
function chunksOf(points) {
  let c = chunkCache.get(points);
  if (c) return c;
  c = [];
  for (let i0 = 0; i0 < Math.max(1, points.length - 1); i0 += CHUNK) {
    const i1 = Math.min(points.length - 1, i0 + CHUNK);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = i0; i <= i1; i++) { const [x, y] = points[i]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    c.push({ i0, i1, x0, y0, x1, y1 });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of c) { x0 = Math.min(x0, k.x0); y0 = Math.min(y0, k.y0); x1 = Math.max(x1, k.x1); y1 = Math.max(y1, k.y1); }
  c.box = { x0, y0, x1, y1 };
  chunkCache.set(points, c);
  return c;
}
const boxHit = (k, bx) => k.x1 >= bx.x0 && k.x0 <= bx.x1 && k.y1 >= bx.y0 && k.y0 <= bx.y1;
const capsuleBox = (a, b, r) => ({ x0: Math.min(a[0], b[0]) - r, y0: Math.min(a[1], b[1]) - r, x1: Math.max(a[0], b[0]) + r, y1: Math.max(a[1], b[1]) + r });

const polyLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };

/**
 * Cut a polyline by the capsule around a→b (radius r). Returns null when the capsule misses it,
 * else the pieces left outside (possibly none). Pieces shorter than minLen are dropped.
 */
export function splitPolyline(points, a, b, r, { minLen = 0 } = {}) {
  if (!points?.length) return null;
  const box = capsuleBox(a, b, r);
  const ch = chunksOf(points);
  if (!boxHit(ch.box, box)) return null;
  if (points.length === 1) {
    return distToSeg(points[0][0], points[0][1], a[0], a[1], b[0], b[1]) <= r ? [] : null;
  }
  const hits = new Map(); // segment index -> [t0, t1]
  for (const k of ch) {
    if (!boxHit(k, box)) continue;
    for (let i = k.i0; i < k.i1; i++) {
      const p = points[i], q = points[i + 1];
      if (Math.max(p[0], q[0]) < box.x0 || Math.min(p[0], q[0]) > box.x1 || Math.max(p[1], q[1]) < box.y0 || Math.min(p[1], q[1]) > box.y1) continue;
      const iv = capsuleInterval(p, q, a, b, r);
      if (iv) hits.set(i, iv);
    }
  }
  if (!hits.size) return null;
  const pieces = [];
  let cur = null;
  const close = () => { if (cur && cur.length >= 2 && polyLen(cur) >= minLen) pieces.push(cur); cur = null; };
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    const iv = hits.get(i);
    if (!iv) {
      if (!cur) cur = [[...p]];
      cur.push([...q]);
      continue;
    }
    const [t0, t1] = iv;
    if (t0 > EPS) { if (!cur) cur = [[...p]]; cur.push(lerpPt(p, q, t0)); }
    close();
    if (t1 < 1 - EPS) cur = [lerpPt(p, q, t1), [...q]];
  }
  close();
  return pieces;
}

/** Bounds of a stroke's points padded by its half width. */
function strokeBox(s) {
  const c = chunksOf(s.points);
  const pad = (s.size || 2) / 2;
  return { x0: c.box.x0 - pad, y0: c.box.y0 - pad, x1: c.box.x1 + pad, y1: c.box.y1 + pad };
}

/** Does the capsule a→b (radius r) touch the stroke's ink at all? Mirrors engine.js hitStroke. */
export function strokeTouches(s, a, b, r) {
  const p = s.points;
  if (!p?.length) return false;
  const rr = r + (s.size || 2) / 2;
  const box = capsuleBox(a, b, r);
  if (!boxHit(strokeBox(s), box)) return false;
  if (s.tool === 'rect') {
    const [u, w] = [p[0], p[p.length - 1]];
    const cs = [[u[0], u[1]], [w[0], u[1]], [w[0], w[1]], [u[0], w[1]]];
    return cs.some((q, i) => { const n = cs[(i + 1) % 4]; return segSegDist(q[0], q[1], n[0], n[1], a[0], a[1], b[0], b[1]) <= rr; });
  }
  if (s.tool === 'wire' && s.curve) return true; // inside the (padded) bounds is close enough for arcs, as hitStroke
  if (p.length === 1) return distToSeg(p[0][0], p[0][1], a[0], a[1], b[0], b[1]) <= rr;
  const pts = s.tool === 'line' || s.tool === 'measure' ? [p[0], p[p.length - 1]] : p;
  if (pts === p) {
    const ch = chunksOf(p), boxR = capsuleBox(a, b, rr);
    for (const k of ch) {
      if (!boxHit(k, boxR)) continue;
      for (let i = k.i0; i < k.i1; i++) if (segSegDist(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], a[0], a[1], b[0], b[1]) <= rr) return true;
    }
    return false;
  }
  return segSegDist(pts[0][0], pts[0][1], pts[1][0], pts[1][1], a[0], a[1], b[0], b[1]) <= rr;
}

/**
 * Erase along a→b with an eraser of radius r (world units) from a list of strokes.
 * @param {object[]} strokes  not modified
 * @param {{ mode?: 'area'|'stroke', canErase?: (s) => boolean, newId?: () => string, minLen?: number }} opts
 * @returns {{ strokes: object[], changed: boolean, removed: object[], added: object[] }}
 *   strokes: the new list (the same array when nothing changed); pieces take the cut stroke's place,
 *   the first keeping its id.
 */
export function eraseStrokes(strokes, a, b, r, { mode = 'area', canErase = () => true, newId = () => Math.random().toString(36).slice(2, 12), minLen = 0 } = {}) {
  const removed = [], added = [];
  let next = null;
  strokes.forEach((s, idx) => {
    let repl = null; // null: keep as is
    if (canErase(s)) {
      if (mode === 'area' && SPLIT_TOOLS.has(s.tool) && s.points?.length) {
        // round caps reach half the width past a cut, so cut that much further out (highlighter is square-ended)
        const reach = r + (s.tool === 'highlighter' ? 0 : (s.size || 2) / 2);
        const src = s.tool === 'line' ? [s.points[0], s.points[s.points.length - 1]] : s.points;
        const pieces = splitPolyline(src, a, b, reach, { minLen });
        // the other pieces remember the stroke they were cut from (the first one ever, for a piece
        // of a piece), so the change history counts a cut as an edit of that stroke, not new marks
        if (pieces) repl = pieces.map((pts, i) => (i === 0 ? { ...s, points: pts } : { ...s, id: newId(), splitFrom: s.splitFrom || s.id, points: pts }));
      } else if (strokeTouches(s, a, b, r)) repl = [];
    }
    if (repl) {
      if (!next) next = strokes.slice(0, idx);
      removed.push(s);
      added.push(...repl);
      next.push(...repl);
    } else if (next) next.push(s);
  });
  return { strokes: next || strokes, changed: !!next, removed, added };
}
