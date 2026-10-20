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
