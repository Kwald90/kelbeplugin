// Freehand ink geometry, kept free of the DOM so it can be tested: collecting pen samples
// into a stroke and turning a stroke's points into path segments. Corners stay sharp: a
// fast V or the apex of an A keeps its tip point, and the path runs straight through it
// instead of rounding it off.

/** Direction change at b on the way a -> b -> c, in degrees (0 = straight on, 180 = doubling back). */
export function turnAngle(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (!lu || !lv) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** A turn sharper than this is drawn as a corner rather than smoothed into a curve... */
export const CORNER_DEG = 55;
/** ...when both sides are at least this long (world units): a mouse's 1 px staircase stays smooth. */
export const CORNER_MIN_LEN = 2;

/**
 * Add one pen sample [x, y, pressure] to a stroke's points. Positions are kept as sampled
 * (no lag filter, which would pull the tip of a V back toward the previous sample); only
 * pressure is eased so the width doesn't flicker. Samples closer than minDist to the last
 * kept point are skipped, but a skipped sample still counts as the stroke's latest position
 * (see endInk). Returns true when the point was kept.
 */
export function addInkPoint(pts, sample, { minDist = 0, pressureEase = 0.6 } = {}) {
  const [x, y] = sample;
  const p = sample[2] ?? 0.5;
  const last = pts[pts.length - 1];
  if (!last) { pts.push([x, y, p]); return true; }
  if (Math.hypot(x - last[0], y - last[1]) < minDist) return false;
  pts.push([x, y, last[2] * (1 - pressureEase) + p * pressureEase]);
  return true;
}

/** Finish a stroke at the pen's last real position, so a quick flick isn't cut short by the distance filter. */
export function endInk(pts, sample) {
  if (!sample || !pts.length) return pts;
  const last = pts[pts.length - 1];
  if (sample[0] !== last[0] || sample[1] !== last[1]) pts.push([sample[0], sample[1], sample[2] ?? last[2]]);
  return pts;
}

/**
 * Path segments for a freehand stroke, starting at pts[0]:
 *   { q: [cx, cy], to: [x, y], p }  quadratic through the sample as control point
 *   { to: [x, y], p }               straight line (used into and out of corners)
 * p is the pressure for the segment. Smooth runs go midpoint to midpoint with each sample
 * as the control point; at a corner the path goes straight to the sample and out again.
 */
export function inkSegments(pts, { cornerDeg = CORNER_DEG, minLen = CORNER_MIN_LEN } = {}) {
  const out = [];
  const n = pts.length;
  if (n < 2) return out;
  if (n === 2) return [{ to: [pts[1][0], pts[1][1]], p: pts[1][2] ?? 0.5 }];
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const mid = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    const p = b[2] ?? 0.5;
    const corner = turnAngle(a, b, c) >= cornerDeg
      && Math.hypot(b[0] - a[0], b[1] - a[1]) >= minLen && Math.hypot(c[0] - b[0], c[1] - b[1]) >= minLen;
    if (corner) {
      out.push({ to: [b[0], b[1]], p });
      out.push({ to: mid, p });
    } else {
      out.push({ q: [b[0], b[1]], to: mid, p });
    }
  }
  const last = pts[n - 1];
  out.push({ to: [last[0], last[1]], p: last[2] ?? 0.5 });
  return out;
}

// ---------- hold-to-snap ----------

const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Distance from p to the segment a-b. */
function segDist(p, a, b) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uu = ux * ux + uy * uy;
  const t = uu ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / uu)) : 0;
  return Math.hypot(p[0] - a[0] - t * ux, p[1] - a[1] - t * uy);
}

/** Douglas-Peucker: indices of pts[i..j) kept at this tolerance, pushed onto out. */
function simplify(pts, i, j, tol, out) {
  let best = -1, bd = tol;
  for (let k = i + 1; k < j; k++) { const d = segDist(pts[k], pts[i], pts[j]); if (d > bd) { bd = d; best = k; } }
  if (best < 0) { out.push(i); return; }
  simplify(pts, i, best, tol, out);
  simplify(pts, best, j, tol, out);
}

/** Snap an angle to level (a multiple of 90°) when within levelDeg of it. */
function level(theta, levelDeg) {
  const q = Math.PI / 2, k = Math.round(theta / q);
  return Math.abs(theta - k * q) <= (levelDeg * Math.PI) / 180 ? k * q : theta;
}

/**
 * Hold-to-snap: what a freehand stroke becomes when the pen is held still at its end.
 *   an open stroke                          -> a straight line from its first point to its last
 *   a closed round one                      -> a circle (axes within 18% of each other) or an ellipse
 *   a closed one with 3 to 6 clear corners  -> that polygon; 4 near-right corners -> a rectangle
 *   a closed scribble                       -> null (left as drawn)
 * Shapes within levelDeg of level are levelled. pts: [x, y, p] in world units.
 * @returns {{ kind: 'line'|'circle'|'ellipse'|'rect'|'polygon', points: number[][] } | null}
 */
export function snapShape(pts, { closeFrac = 0.22, levelDeg = 6 } = {}) {
  if (!pts || pts.length < 2) return null;
  const n = pts.length;
  const A = pts[0], B = pts[n - 1];
  const p = pts.reduce((s, q) => s + (q[2] ?? 0.5), 0) / n;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
    if (i) len += hyp(pts[i - 1], q);
  }
  const D = Math.hypot(x1 - x0, y1 - y0);
  if (!(D > 0)) return null;
  const line = { kind: 'line', points: [[A[0], A[1], p], [B[0], B[1], p]] };
  // closed: the end came back to the start, or overshot a little past it (a circle drawn round again)
  let back = hyp(A, B), iBack = 0;
  for (let i = 1; i < n * 0.3; i++) { const dd = hyp(pts[i], B); if (dd < back) { back = dd; iBack = i; } }
  const closed = n >= 8 && back <= closeFrac * D && len >= 1.8 * D;
  if (!closed) return line;
  // drawn past the start: fit the one loop from where the end came back to, not the overlap twice
  if (iBack > 2) return snapShape(pts.slice(iBack), { closeFrac, levelDeg });

  // ---- an ellipse from the moments of the path (weighted by length, so sampling density doesn't matter)
  let w = 0, cx = 0, cy = 0;
  const segs = [];
  for (let i = 1; i < n; i++) {
    const l = hyp(pts[i - 1], pts[i]);
    if (!l) continue;
    const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
    segs.push([mx, my, l]); w += l; cx += mx * l; cy += my * l;
  }
  if (!w) return null;
  cx /= w; cy /= w;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [mx, my, l] of segs) { sxx += (mx - cx) ** 2 * l; syy += (my - cy) ** 2 * l; sxy += (mx - cx) * (my - cy) * l; }
  sxx /= w; syy /= w; sxy /= w;
  // the axes' direction from the moments; their lengths and the centre from how far the stroke reaches along them
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const us = pts.map((q) => ct * q[0] + st * q[1]), vs = pts.map((q) => -st * q[0] + ct * q[1]);
  const umin = Math.min(...us), umax = Math.max(...us), vmin = Math.min(...vs), vmax = Math.max(...vs);
  const a = (umax - umin) / 2, b = (vmax - vmin) / 2, cu = (umax + umin) / 2, cv = (vmax + vmin) / 2;
  const ecx = ct * cu - st * cv, ecy = st * cu + ct * cv;
  let ellErr = Infinity;
  if (a > 0 && b > 0) ellErr = us.reduce((acc, u, i) => acc + Math.abs(Math.hypot((u - cu) / a, (vs[i] - cv) / b) - 1), 0) / n;
  const R = (a + b) / 2;

  // ---- a polygon: Douglas-Peucker round the loop, starting from the point farthest out
  let i0 = 0;
  for (let i = 1; i < n; i++) if (Math.hypot(pts[i][0] - cx, pts[i][1] - cy) > Math.hypot(pts[i0][0] - cx, pts[i0][1] - cy)) i0 = i;
  const loop = [...pts.slice(i0), ...pts.slice(0, i0 + 1)];
  let i1 = 0;
  for (let i = 1; i < loop.length; i++) if (hyp(loop[0], loop[i]) > hyp(loop[0], loop[i1])) i1 = i;
  const keep = [];
  const tol = 0.045 * D;
  simplify(loop, 0, i1, tol, keep);
  simplify(loop, i1, loop.length - 1, tol, keep);
  const verts = [...new Set(keep)].map((i) => loop[i]);
  // drop vertices where the outline barely turns, and ones crowding their neighbour
  for (let changed = true; changed && verts.length > 3;) {
    changed = false;
    for (let i = 0; i < verts.length && verts.length > 3; i++) {
      const pv = verts[(i - 1 + verts.length) % verts.length], nx = verts[(i + 1) % verts.length];
      if (turnAngle(pv, verts[i], nx) < 25 || hyp(pv, verts[i]) < 0.08 * D) { verts.splice(i, 1); changed = true; break; }
    }
  }
  let polyErr = Infinity;
  if (verts.length >= 3 && verts.length <= 6) {
    polyErr = pts.reduce((acc, q) => {
      let m = Infinity;
      for (let i = 0; i < verts.length; i++) m = Math.min(m, segDist(q, verts[i], verts[(i + 1) % verts.length]));
      return acc + m;
    }, 0) / n / (R || 1);
  }

  const polyOk = polyErr < 0.07, ellOk = ellErr < 0.12;
  if (polyOk && (!ellOk || polyErr < ellErr * 0.8)) {
    const inner = verts.map((v, i) => 180 - turnAngle(verts[(i - 1 + verts.length) % verts.length], v, verts[(i + 1) % verts.length]));
    if (verts.length === 4 && inner.every((g) => Math.abs(g - 90) <= 18)) {
      // a rectangle: square it up along its longest side
      let li = 0;
      for (let i = 1; i < 4; i++) if (hyp(verts[i], verts[(i + 1) % 4]) > hyp(verts[li], verts[(li + 1) % 4])) li = i;
      const e0 = verts[li], e1 = verts[(li + 1) % 4];
      const th = level(Math.atan2(e1[1] - e0[1], e1[0] - e0[0]), levelDeg);
      const c = Math.cos(th), s = Math.sin(th);
      const us = verts.map((v) => c * v[0] + s * v[1]), vs = verts.map((v) => -s * v[0] + c * v[1]);
      const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
      const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [c * u - s * v, s * u + c * v, p]);
      return { kind: 'rect', points: [...corners, [...corners[0]]] };
    }
    const ring = verts.map((v) => [v[0], v[1], p]);
    return { kind: 'polygon', points: [...ring, [...ring[0]]] };
  }
  if (ellOk) {
    const circle = Math.max(a, b) / Math.min(a, b) < 1.18;
    const ra = circle ? R : a, rb = circle ? R : b;
    const th = circle ? 0 : level(theta, levelDeg);
    const c = Math.cos(th), s = Math.sin(th), N = 72, out = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2, u = ra * Math.cos(t), v = rb * Math.sin(t);
      out.push([ecx + c * u - s * v, ecy + s * u + c * v, p]);
    }
    out.push([...out[0]]); // closed exactly
    return { kind: circle ? 'circle' : 'ellipse', points: out };
  }
  return null;
}
