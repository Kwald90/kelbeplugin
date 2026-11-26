// Bend diagrams as SVG strings: the bent pipe drawn to scale, and the straight pipe with its
// marks. Pure (no DOM), so the screen, the print sheet and the tests share one renderer.
// Colours come from CSS classes in css/bending.css (tokens only).
//
// Each diagram is laid out as a scene first: the pipe, the obstruction, the dimension lines and
// every label, each with its box. Labels go into free space one at a time (beside their bend first,
// then further out with a leader line), so no two labels touch and none sits on the pipe. The view
// box is then fitted to everything drawn, so nothing is cropped at any width. The *Layout functions
// return that scene with the svg (the tests check it); the *Svg functions return just the svg.
import { tracePath, fmtDeg, filletPoints, obstacleShape, obstacleClearance, polylineClearance } from './bending.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mmFmt = (m) => `${Math.round(m * 1000)} mm`;
const FONT = 12;
const MARGIN = 10; // clear space around everything drawn
const GAP = 3;     // clear space around each label (the CSS gives text a 2px halo)

// ---------------------------------------------------------------------------
// Text size and boxes. One approximation, used to place labels and by the tests: each character is
// a set fraction of the font size wide (measured in Chrome with the system font, rounded up ~10%).
// ---------------------------------------------------------------------------

/** Font size of each text class in px (keep in step with css/bending.css). */
export const TEXT_SIZE = {
  'bd-text': 12, 'bd-angle': 13, 'bd-dimtext': 12, 'bd-risetext': 12, 'bd-endtext': 11, 'bd-marktag': 13,
  'bd-note': 11, 'bd-pos': 12, 'bd-callout': 11, 'bd-rowtitle': 12, 'bd-warntext': 12,
};
const sizeOf = (cls) => TEXT_SIZE[cls] ?? FONT;
const charEm = (ch) => (/[—×MW@%mw]/.test(ch) ? 1.05 : /[A-Z]/.test(ch) ? 0.8 : /[ .,:;'"·°/|!ijlI()[\]-]/.test(ch) ? 0.38 : 0.66);

/** Width of a line of text in px. */
export function textWidth(str, cls = 'bd-text') {
  const s = String(str ?? '');
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return (em + (cls === 'bd-endtext' ? 0.06 * s.length : 0)) * sizeOf(cls); // END is letter-spaced
}

/** The box a line of text covers, { x0, y0, x1, y1 }, for a baseline at y. */
export function textBox(x, y, str, cls = 'bd-text', anchor = 'middle') {
  const size = sizeOf(cls), w = textWidth(str, cls);
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  return { x0, y0: y - 0.78 * size, x1: x0 + w, y1: y + 0.22 * size };
}

/** Do two boxes overlap (or come closer than `gap`)? */
export const boxesOverlap = (a, b, gap = 0) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
const grow = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });
const ptsBox = (pts, pad = 0) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
};
const finiteBox = (b) => !!b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite);

/** Does the segment a–b cross the box? (Liang–Barsky) */
function segHitsBox(ax, ay, bx, by, b) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - b.x0], [dx, b.x1 - ax], [-dy, ay - b.y0], [dy, b.y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
/** Distance between the segment a–b and a box (0 when they touch). */
function segBoxDist(ax, ay, bx, by, b) {
  if (segHitsBox(ax, ay, bx, by, b)) return 0;
  const toBox = (x, y) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const toSeg = (x, y) => { const t = L ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0; return Math.hypot(ax + dx * t - x, ay + dy * t - y); };
  return Math.min(toBox(ax, ay), toBox(bx, by), toSeg(b.x0, b.y0), toSeg(b.x1, b.y0), toSeg(b.x0, b.y1), toSeg(b.x1, b.y1));
}
/** Distance from an obstruction shape (px) to a box. */
function shapeBoxDist(sh, b) {
  if (sh.shape === 'circle') return Math.hypot(Math.max(b.x0 - sh.cx, 0, sh.cx - b.x1), Math.max(b.y0 - sh.cy, 0, sh.cy - b.y1)) - sh.r;
  return Math.hypot(Math.max(b.x0 - sh.x1, 0, sh.x0 - b.x1), Math.max(b.y0 - sh.y1, 0, sh.y0 - b.y1));
}

function text(x, y, s, cls = 'bd-text', anchor = 'middle') {
  return `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" text-anchor="${anchor}">${esc(s)}</text>`;
}
function line(x1, y1, x2, y2, cls) {
  return `<line class="${cls}" x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}"/>`;
}
const ptsAttr = (pts) => pts.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ');
const poly = (pts, cls, w) => `<polyline class="${cls}" points="${ptsAttr(pts)}"${w ? ` stroke-width="${n1(w)}"` : ''}/>`;

// ---------------------------------------------------------------------------
// The scene: what is drawn (in layers), what labels keep clear of, and the labels themselves
// ---------------------------------------------------------------------------

class Scene {
  constructor() {
    this.layers = { bg: [], pipe: [], mid: [], fg: [] };
    this.labels = [];   // { text, cls, box, role }
    this.elements = []; // { kind, box } for everything drawn
    this.avoid = [];    // what labels keep clear of
    this.bounds = null;
    this.pipes = [];
    this.obstacle = null;
    this.warnings = [];
  }

  /** Draw svg on a layer; `box` (px) counts toward the view. */
  draw(svg, box, layer = 'fg', kind = 'shape') {
    if (svg) this.layers[layer].push(svg);
    if (finiteBox(box)) { this.elements.push({ kind, box }); this.bounds = grow(this.bounds, box); }
  }
  keepClear(box) { if (finiteBox(box)) this.avoid.push({ t: 'box', b: box }); }
  keepClearSeg(ax, ay, bx, by, hw = 1) { this.avoid.push({ t: 'seg', ax, ay, bx, by, hw }); }
  keepClearLine(pts, hw) { for (let i = 1; i < pts.length; i++) this.keepClearSeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], hw); }
  keepClearShape(sh) { this.avoid.push({ t: 'shape', sh }); }

  /** Is this box clear of every label and everything labels avoid? */
  fits(b, gap = GAP) {
    for (const l of this.labels) if (boxesOverlap(b, l.box, gap)) return false;
    for (const o of this.avoid) {
      if (o.t === 'box' ? boxesOverlap(b, o.b, gap)
        : o.t === 'seg' ? segBoxDist(o.ax, o.ay, o.bx, o.by, b) < o.hw + gap
          : shapeBoxDist(o.sh, b) < gap) return false;
    }
    return true;
  }
  /** Would a leader from a to b cross a label? */
  leaderClear(ax, ay, bx, by) {
    for (const l of this.labels) {
      if (segHitsBox(ax, ay, bx, by, { x0: l.box.x0 - 1, y0: l.box.y0 - 1, x1: l.box.x1 + 1, y1: l.box.y1 + 1 })) return false;
    }
    return true;
  }

  /** A label at a fixed spot (the caller made room for it). */
  text(x, y, str, cls, anchor = 'middle', role = 'label') {
    const box = textBox(x, y, str, cls, anchor);
    this.labels.push({ text: String(str), cls, box, role });
    this.draw(text(x, y, str, cls, anchor), box, 'fg', 'text');
    return box;
  }
  leader(ax, ay, bx, by) {
    this.draw(line(ax, ay, bx, by, 'bd-leader'), ptsBox([[ax, ay], [bx, by]]), 'fg', 'leader');
    this.keepClearSeg(ax, ay, bx, by, 1);
  }

  /**
   * Put a label near the anchor (ax, ay), clear of every other label and of the pipe. Tries the
   * preferred direction first, swings round, then steps further out; past the first few steps a
   * leader line runs back to the anchor. `near` is the gap at the anchor (half the pipe, say).
   * It always places the label: the last resort is a row of its own below everything.
   */
  place(str, cls, ax, ay, { dir = [0, -1], near = 4, role = 'label' } = {}) {
    const size = sizeOf(cls), w = textWidth(str, cls), h = size;
    const base = Math.atan2(dir[1], dir[0]);
    for (const dr of [0, 5, 11, 18, 27, 38, 52, 70, 92, 120, 155, 200, 260, 330]) {
      for (const da of [0, 25, -25, 50, -50, 75, -75, 105, -105, 135, -135, 165, -165, 180]) {
        const a = base + (da * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
        const reach = near + dr + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
        const cx = ax + ux * reach, cy = ay + uy * reach;
        const b = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        if (!this.fits(b)) continue;
        if (dr >= 18) {
          const sx = ax + ux * near * 0.6, sy = ay + uy * near * 0.6;
          const ex = clamp(sx, b.x0, b.x1), ey = clamp(sy, b.y0, b.y1);
          if (!this.leaderClear(sx, sy, ex, ey)) continue;
          this.leader(sx, sy, ex, ey);
        }
        return this.text(cx, cy + h / 2 - 0.22 * size, str, cls, 'middle', role);
      }
    }
    const top = (this.bounds ? this.bounds.y1 : ay) + GAP + 2;
    this.leader(ax, ay, ax, top);
    return this.text(ax, top + 0.78 * size, str, cls, 'middle', role);
  }
}

/**
 * Wrap a scene in an <svg> whose view box holds everything drawn, shown `width` px wide. With
 * `reveal` (a SMIL duration) the labels layer fades in as the animated bend settles.
 */
function finishScene(sc, width, ariaLabel, { cls = 'bend-svg', reveal = null } = {}) {
  const b = sc.bounds || { x0: 0, y0: 0, x1: width - 2 * MARGIN, y1: 80 };
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const vw = Math.max(width, Math.ceil(bw + 2 * MARGIN - 0.5)); // fitWidth allows half a pixel over
  const vh = Math.ceil(bh + 2 * MARGIN);
  const tx = n1(MARGIN - b.x0 + Math.max(0, (vw - 2 * MARGIN - bw) / 2)), ty = n1(MARGIN - b.y0);
  const height = Math.max(1, Math.round((vh * width) / vw));
  const fg = sc.layers.fg.join('');
  const top = reveal
    ? `<g class="bd-reveal" opacity="1"><animate class="bd-anim" attributeName="opacity" dur="${reveal}" begin="indefinite" fill="freeze" calcMode="linear" keyTimes="0;0.55;1" values="0;0;1"/>${fg}</g>`
    : fg;
  const inner = sc.layers.bg.join('') + sc.layers.pipe.join('') + sc.layers.mid.join('') + top;
  const svg = `<svg class="${cls}" viewBox="0 0 ${vw} ${vh}" width="${width}" height="${height}" role="img" aria-label="${esc(ariaLabel)}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${tx},${ty})">${inner}</g></svg>`;
  const mv = (x) => ({ x0: x.x0 + tx, y0: x.y0 + ty, x1: x.x1 + tx, y1: x.y1 + ty });
  const o = sc.obstacle;
  return {
    svg, width, height, viewBox: [0, 0, vw, vh],
    labels: sc.labels.map((l) => ({ ...l, box: mv(l.box) })),
    elements: sc.elements.map((e) => ({ ...e, box: mv(e.box) })),
    pipes: sc.pipes.map((p) => ({ ...p, points: p.points.map(([x, y]) => [x + tx, y + ty]) })),
    obstacle: o ? (o.shape === 'circle' ? { ...o, cx: o.cx + tx, cy: o.cy + ty } : { ...o, ...mv(o) }) : null,
    warnings: sc.warnings,
  };
}

/** Lay out at a scale, then shrink the drawing until it and its labels fit `avail` px wide. */
function fitWidth(draw, scale0, spanPx, avail) {
  const wide = (sc) => (sc.bounds ? sc.bounds.x1 - sc.bounds.x0 : 0) > avail + 0.5;
  let s = scale0, sc = draw(s);
  // a few smart steps: the labels' overhang stays the same while the drawing shrinks
  for (let it = 0; it < 5 && wide(sc); it++) {
    const bw = sc.bounds.x1 - sc.bounds.x0;
    const next = (avail - (bw - spanPx(s))) / (spanPx(s) / s || 1);
    s = Math.max(s * 0.35, Math.min(next, s * 0.97));
    sc = draw(s);
  }
  // then plain steps for layouts that don't shrink in proportion (marks spread apart to stay legible)
  for (let it = 0; it < 12 && wide(sc); it++) { s *= 0.85; sc = draw(s); }
  return sc;
}

// ---------------------------------------------------------------------------
// The bent pipe
// ---------------------------------------------------------------------------

/** A dimension line with end ticks; its label goes beside it, on the `dir` side. */
function dim(sc, [x1, y1, x2, y2, label, dir, lineCls, textCls]) {
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
  const t = 5;
  const ticks = vertical
    ? [[x1 - t, y1, x1 + t, y1], [x2 - t, y2, x2 + t, y2]]
    : [[x1, y1 - t, x1, y1 + t], [x2, y2 - t, x2, y2 + t]];
  sc.draw(line(x1, y1, x2, y2, lineCls) + ticks.map(([a, b, c, d]) => line(a, b, c, d, lineCls)).join(''), ptsBox([[x1, y1], [x2, y2]], t), 'fg', 'dim');
  for (const [a, b, c, d] of ticks) sc.keepClearSeg(a, b, c, d, 1);
  sc.place(label, textCls, (x1 + x2) / 2, (y1 + y2) / 2, { dir, near: 4, role: 'dim' });
}

/** Two slanted lines across the pipe: this stretch is not drawn to scale. */
function breakMark(x, y, angleDeg, size) {
  const a = (angleDeg * Math.PI) / 180;
  const nx = -Math.sin(a), ny = -Math.cos(a); // screen normal (y down)
  const tx = Math.cos(a), ty = -Math.sin(a);
  const h = size / 2 + 6;
  const g = 4;
  const seg = (o) => line(x + tx * o - nx * h + tx * 3, y + ty * o - ny * h + ty * 3, x + tx * o + nx * h - tx * 3, y + ty * o + ny * h - ty * 3, 'bd-break');
  const corners = [
    [x - tx * g - nx * h, y - ty * g - ny * h], [x + tx * g - nx * h, y + ty * g - ny * h],
    [x + tx * g + nx * h, y + ty * g + ny * h], [x - tx * g + nx * h, y - ty * g + ny * h],
  ];
  return { svg: `<polygon class="bd-gap" points="${ptsAttr(corners)}"/>${seg(-g)}${seg(g)}`, box: ptsBox(corners, 3) };
}

// Shorten a long lead-in or tail so the bends stay readable; the dimensions keep true values.
function capSegments(segments, startHeading, leadIn = false) {
  const segs = segments.map((s) => ({ ...s }));
  const breaks = [];
  if (segs.length < 3) return { segs, breaks, shiftM: 0 };
  let span = 0;
  // a first leg that is part of the bend (stub, kick) counts toward the span
  for (let i = startHeading === 0 ? 1 : 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s.straightM != null) span += s.straightM;
    else if (s.radiusM) span += (s.radiusM * Math.abs(s.bendDeg) * Math.PI) / 180;
  }
  span = Math.max(span, 0.05);
  const last = segs.length - 1;
  // measured from mark 1: draw some pipe before it so the first bend reads as a bend
  if (leadIn && startHeading === 0 && segs[0].straightM < 0.25 * span) segs[0].straightM = 0.25 * span;
  if (startHeading === 0 && segs[0].straightM > 1.2 * span) { segs[0].straightM = 0.4 * span; breaks.push('first'); }
  if (segs[last].straightM > 1.2 * span) { segs[last].straightM = 0.4 * span; breaks.push('last'); }
  // how far the drawing slid along the surface, so the obstruction slides with it
  const shiftM = startHeading === 0 ? segments[0].straightM - segs[0].straightM : 0;
  return { segs, breaks, shiftM };
}

/**
 * The pipe segment lists to draw for a result, before tracing: [{ segs, start, main, breaks, shiftM }].
 * `segs` is a tracePath segment list; scaling its bendDeg lets the animated renderer form the bend.
 */
function pipeSegsFor(result) {
  const out = [];
  const startH = result.start?.headingDeg ?? 0;
  if (result.kind === 'concentric') {
    const leg = result.topM ? Math.max(0.02, result.topM - result.innerRadiusM) : result.innerRadiusM * 0.5;
    for (const p of result.pipes) {
      const lead = Math.min(result.startM, Math.max(result.innerRadiusM * 0.4, 0.05));
      const segs = [{ straightM: lead }, { bendDeg: 90, radiusM: p.radiusM }, { straightM: leg }];
      out.push({ segs, start: { x: 0, y: -(p.index - 1) * result.centersM }, main: p.index === 1, breaks: lead < result.startM ? ['first'] : [], shiftM: 0 });
    }
    return out;
  }
  if (result.kind === 'parallel') {
    const cap = capSegments(result.segments, 0, result.reference === 'mark1');
    const cut = result.segments[0].straightM - cap.segs[0].straightM; // negative when a lead-in was added
    for (const p of result.pipes) {
      const [a, b] = p.marks;
      const segs = [{ straightM: a.atM - cut }, { bendDeg: result.angleDeg }, { straightM: b.atM - a.atM }, { bendDeg: -result.angleDeg }, { straightM: cap.segs[cap.segs.length - 1].straightM }];
      out.push({ segs, start: { x: 0, y: -(p.index - 1) * result.centersM }, main: p.index === 1, breaks: cap.breaks, shiftM: cut });
    }
    return out;
  }
  const cap = capSegments(result.segments, startH, result.reference === 'mark1');
  out.push({ segs: cap.segs, start: result.start, main: true, breaks: cap.breaks, shiftM: cap.shiftM });
  return out;
}

// Bends drawn with the bender's radius on their corners (the others carry their own arcs, or are shots).
const ROUNDED = new Set(['offset', 'kick', 'saddle3', 'saddle4', 'boxOffset', 'rolling', 'parallel']);

/** Ease-in-out so the bend forms gently at both ends of the play. */
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Even out a polyline to `count` points by arc length (so each animation frame has the same count). */
function resample(points, count) {
  if (count < 2 || points.length < 2) { const p = points[0] || [0, 0]; return Array.from({ length: Math.max(1, count) }, () => p.slice()); }
  const seg = []; let total = 0;
  for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); seg.push(d); total += d; }
  if (total === 0) return Array.from({ length: count }, () => points[0].slice());
  const out = [points[0].slice()];
  const stepLen = total / (count - 1);
  let s = 0, pos = 0;
  for (let k = 1; k < count - 1; k++) {
    let remain = stepLen;
    while (s < seg.length && remain > seg[s] - pos) { remain -= seg[s] - pos; s++; pos = 0; }
    if (s >= seg.length) { out.push(points[points.length - 1].slice()); continue; }
    pos += remain;
    const t = seg[s] === 0 ? 0 : pos / seg[s];
    const a = points[s], b = points[s + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  out.push(points[points.length - 1].slice());
  return out;
}

/** The pipes traced in metres (corners rounded to the bend radius) and the obstruction to match. */
function heroGeometry(result, od) {
  const defs = pipeSegsFor(result);
  const radius = ROUNDED.has(result.kind) && result.bendRadiusM > 0 ? result.bendRadiusM : 0;
  const trace = (d, t) => {
    const p = tracePath(d.segs.map((s) => (s.bendDeg != null ? { ...s, bendDeg: s.bendDeg * t } : s)), d.start);
    return { points: radius ? filletPoints(p.points, radius, 8) : p.points, corners: p.points, bends: p.bends };
  };
  const finals = defs.map((d) => ({ ...trace(d, 1), main: d.main, breaks: d.breaks }));
  let shape = obstacleShape(result, od);
  if (shape) {
    const dx = -(defs[0].shiftM || 0);
    shape = shape.shape === 'circle' ? { ...shape, cx: shape.cx + dx } : { ...shape, x0: shape.x0 + dx, x1: shape.x1 + dx };
  }
  // the bend as really bent: does it clear what it was laid out for?
  const clear = shape ? obstacleClearance(result, { odM: od, radiusM: radius }) : null;
  return { defs, trace, finals, shape, clashes: !!clear && !clear.ok };
}

/**
 * Lower a drawn obstruction until the drawn pipe (outside half-width `hw`) rests on it, not in it.
 * Returns the seated shape, or null if even a sliver of it would sit under the pipe.
 */
function seatObstacle(sh, pipesPx, hw) {
  let s = { ...sh };
  const near = () => {
    // only the parts of the pipe beside the obstruction matter
    const bb = s.shape === 'circle' ? { x0: s.cx - s.r, x1: s.cx + s.r, y0: s.cy - s.r, y1: s.cy + s.r } : s;
    const out = [];
    for (const pts of pipesPx) {
      for (let i = 1; i < pts.length; i++) if (boxesOverlap(ptsBox([pts[i - 1], pts[i]], hw + 2), bb)) out.push([pts[i - 1], pts[i]]);
    }
    return out;
  };
  const clearance = () => { let c = Infinity; for (const seg of near()) c = Math.min(c, polylineClearance(seg, s, hw)); return c; };
  for (let it = 0; it < 16; it++) {
    const clear = clearance();
    if (clear >= 0) return s;
    const d = -clear + 0.6;
    if (s.shape === 'circle') {
      const r = Math.max(1, s.r - d / 2);
      s = { ...s, cy: s.cy + (s.r - r), r }; // the bottom stays on the surface
      if (r <= 1) break;
    } else {
      s = { ...s, y0: Math.min(s.y1 - 1, s.y0 + d) };
      if (s.y0 >= s.y1 - 1) break;
    }
  }
  return clearance() >= 0 ? s : null;
}

/** A curved arrow at the first bend showing which way the leg swings — "face the bender this way". */
function directionArrow(b0, X, Y, pipeW) {
  if (!b0 || !b0.bendDeg) return null;
  const cx = X(b0.x), cy = Y(b0.y);
  const r = pipeW / 2 + 12;
  const a0 = -((b0.headingDeg - b0.bendDeg / 2) * Math.PI) / 180; // screen angle (y flips)
  const a1 = -((b0.headingDeg + b0.bendDeg / 2) * Math.PI) / 180;
  const steps = 10;
  const pts = [];
  for (let k = 0; k <= steps; k++) { const a = a0 + ((a1 - a0) * k) / steps; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  const [hx, hy] = pts[steps];
  const [px, py] = pts[steps - 1];
  const ang = Math.atan2(hy - py, hx - px);
  const ah = 5.5;
  const h1 = [hx - ah * Math.cos(ang - 0.5), hy - ah * Math.sin(ang - 0.5)], h2 = [hx - ah * Math.cos(ang + 0.5), hy - ah * Math.sin(ang + 0.5)];
  const head = `<path class="bd-dir" d="M${n1(hx)},${n1(hy)} L${n1(h1[0])},${n1(h1[1])} M${n1(hx)},${n1(hy)} L${n1(h2[0])},${n1(h2[1])}"/>`;
  return { svg: poly(pts, 'bd-dir') + head, pts: [...pts, h1, h2] };
}

/**
 * Stroke layers that shade the pipe like a convex steel tube: a dark edge under a mid body under a
 * light band under a thin highlight. Centred strokes of shrinking width read as a round cylinder.
 * Widest first (drawn underneath). Shared by the static and animated renderers so they stay in step.
 */
export const pipeLayers = (w) => [
  ['bd-pipe', w + 2],
  ['bd-pipe-2', w],
  ['bd-pipe-3', Math.max(2, w * 0.56)],
  ['bd-pipe-hi', Math.max(1, w * 0.22)],
];

const shortTag = (m) => {
  const n = /(\d+)$/.exec(m.label);
  if (n) return n[1];
  if (/start/i.test(m.label)) return 'start';
  if (/end/i.test(m.label)) return 'end';
  return '';
};
/** Screen direction pointing out of a bend (the convex side). */
const outside = (b) => { const hh = (b.headingDeg * Math.PI) / 180, k = Math.sign(b.bendDeg) || 1; return [Math.sin(hh) * k, Math.cos(hh) * k]; };

/**
 * Lay the bent pipe out at `s` px per metre. `pipeDraw(sc, P, pipeW)` draws the pipe polylines
 * (still or animated) and returns every px point they pass through, so the view holds all frames.
 */
function drawHero(result, G, geo, s, od, fmt, pipeDraw) {
  const sc = new Scene();
  const X = (x) => (x - geo.minX) * s, Y = (y) => (geo.maxY - y) * s, P = ([x, y]) => [X(x), Y(y)];
  // the pipe is drawn to scale where that reads as a tube, else 9px; over a small obstruction it
  // may go down to 4px, so the obstruction still shows under it
  const obstPx = G.shape ? (G.shape.shape === 'circle' ? 2 * G.shape.r : G.shape.y1 - G.shape.y0) * s : Infinity;
  const pipeW = Math.max(clamp(obstPx * 0.5, 4, 9), od * s);
  const hw = (pipeW + 2) / 2; // the outside of the drawn pipe (its widest shade layer)
  const finals = G.finals.map((p) => ({ ...p, px: p.points.map(P) }));
  const main = finals.find((p) => p.main);
  const lowest = Math.min(...finals.flatMap((p) => p.points.map((q) => q[1])));
  const pipeMaxX = Math.max(...finals.flatMap((p) => p.points.map((q) => q[0])));
  sc.pipes = finals.map((p) => ({ points: p.px, halfW: hw }));

  // behind the pipe: the surface it lies on, and the obstruction
  if (['offset', 'saddle3', 'saddle4', 'boxOffset', 'rolling', 'parallel'].includes(result.kind)) {
    const ys = Y(lowest - od / 2);
    sc.draw(line(X(geo.minX), ys, X(geo.maxX), ys, 'bd-surface'), { x0: X(geo.minX), y0: ys - 1, x1: X(geo.maxX), y1: ys + 1 }, 'bg', 'surface');
    sc.keepClearSeg(X(geo.minX), ys, X(geo.maxX), ys, 1);
  }
  let obst = null;
  if (G.shape) {
    const w = G.shape;
    obst = w.shape === 'circle'
      ? { shape: 'circle', cx: X(w.cx), cy: Y(w.cy), r: w.r * s }
      : { shape: 'rect', x0: X(w.x0), x1: Number.isFinite(w.x1) ? X(w.x1) : X(pipeMaxX), y0: Y(w.y1), y1: Y(w.y0) };
    if (obst.shape === 'rect' && obst.x1 - obst.x0 < 2) obst = null;
  }
  if (obst) {
    // A bend that clears in real life is drawn resting on its obstruction (the drawn pipe is a touch
    // fatter than the real one). One that can't clear is drawn as a red outline over the pipe with a
    // warning, never as a pipe running through a solid block.
    if (!G.clashes) obst = seatObstacle(obst, finals.map((p) => p.px), hw + 0.75);
  }
  if (obst) {
    obst.clash = G.clashes;
    const cls = G.clashes ? 'bd-obst bd-clash' : 'bd-obst';
    const svg = obst.shape === 'circle'
      ? `<circle class="${cls}" cx="${n1(obst.cx)}" cy="${n1(obst.cy)}" r="${n1(Math.max(obst.r, 1))}"/>`
      : `<rect class="${cls}" x="${n1(obst.x0)}" y="${n1(obst.y0)}" width="${n1(obst.x1 - obst.x0)}" height="${n1(Math.max(1, obst.y1 - obst.y0))}"/>`;
    const box = obst.shape === 'circle' ? { x0: obst.cx - obst.r, y0: obst.cy - obst.r, x1: obst.cx + obst.r, y1: obst.cy + obst.r } : { x0: obst.x0, y0: obst.y0, x1: obst.x1, y1: obst.y1 };
    sc.draw(svg, box, G.clashes ? 'mid' : 'bg', 'obstacle');
    sc.keepClearShape(obst);
    sc.obstacle = obst;
  }

  // the pipe, then what labels keep off: the pipe body, break marks, the arrow, the end marker
  const pipePts = pipeDraw(sc, P, pipeW);
  sc.draw('', ptsBox(pipePts, hw), 'pipe', 'pipe');
  for (const p of finals) sc.keepClearLine(p.px, hw + 1);
  for (const p of finals) {
    const at = (a, b) => {
      const k = breakMark((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, pipeW);
      sc.draw(k.svg, k.box, 'mid', 'break');
      sc.keepClear(k.box);
    };
    if (p.breaks.includes('first') && p.px.length > 1) at(p.px[0], p.px[1]);
    if (p.breaks.includes('last') && p.px.length > 1) at(p.px[p.px.length - 2], p.px[p.px.length - 1]);
  }
  const arrow = directionArrow(main.bends[0], X, Y, pipeW);
  if (arrow) { const b = ptsBox(arrow.pts, 2); sc.draw(arrow.svg, b, 'mid', 'arrow'); sc.keepClear(b); }
  const [ex, ey] = main.px[0];
  const endR = Math.min(7, Math.max(3, pipeW / 2));
  if (result.reference !== 'mark1') {
    const b = { x0: ex - endR - 1, y0: ey - endR - 1, x1: ex + endR + 1, y1: ey + endR + 1 };
    sc.draw(`<circle class="bd-end" cx="${n1(ex)}" cy="${n1(ey)}" r="${n1(endR)}"/>`, b, 'fg', 'end');
    sc.keepClear(b);
  }

  // dimension lines: placed now so every label keeps off them; their own labels come after the bends
  const dims = result.dims || [];
  const dimLines = [];
  for (const d of dims) {
    if (d.type === 'rise' && main.bends.length >= 2) {
      const x = X(pipeMaxX) + hw + 10;
      dimLines.push([x, Y(main.corners[0][1]), x, Y(main.bends[1].y), fmt(d.label), [1, 0], 'bd-dim-rise', 'bd-risetext']);
    } else if (d.type === 'kick' && main.bends.length) {
      const x = X(geo.minX) - hw - 8;
      dimLines.push([x, Y(0), x, Y(main.bends[0].y), fmt(d.label), [-1, 0], 'bd-dim-rise', 'bd-risetext']);
    } else if (d.type === 'stub') {
      const x = X(geo.minX) - hw - 8;
      dimLines.push([x, Y(0), x, Y(lowest - od / 2), fmt(d.label), [-1, 0], 'bd-dim-rise', 'bd-risetext']);
    } else if (d.type === 'leg' || d.type === 'backToBack') {
      const y = Y(lowest - od / 2) + hw + 14;
      const end = main.points[main.points.length - 1][0] + (d.type === 'backToBack' ? od / 2 : 0);
      dimLines.push([X(-od / 2), y, X(end), y, fmt(d.label), [0, 1], 'bd-dim', 'bd-dimtext']);
    }
  }
  for (const [x1, y1, x2, y2] of dimLines) sc.keepClearSeg(x1, y1, x2, y2, 2);

  // the bend labels first (the marks matter most), on the outside of each bend
  const bendMarks = result.marks.filter((m) => m.angleDeg && (!m.pipe || m.pipe === 1));
  if (result.kind === 'segment') {
    const mid = main.bends[Math.floor(main.bends.length / 2)];
    if (mid) sc.place(`${fmtDeg(result.angleDeg ?? 90)} in ${result.shots} shots`, 'bd-angle', X(mid.x), Y(mid.y), { dir: outside(mid), near: hw + 4, role: 'mark' });
  } else if (result.kind !== 'concentric') {
    main.bends.forEach((b, i) => {
      const m = bendMarks[i];
      const label = [m ? shortTag(m) : '', fmtDeg(Math.abs(b.bendDeg))].filter(Boolean).join(' · ');
      sc.place(label, 'bd-angle', X(b.x), Y(b.y), { dir: outside(b), near: hw + 4, role: 'mark' });
    });
  }
  for (const d of dimLines) dim(sc, d);
  if (result.reference !== 'mark1') sc.place('END', 'bd-endtext', ex, ey, { dir: [0, -1], near: endR + 2, role: 'end' });

  for (const d of dims) {
    if (d.type === 'obstacle' && obst) {
      const label = d.round ? fmt(d.heightM) : `${fmt(d.heightM)} × ${fmt(d.widthM)}`;
      const cx = obst.shape === 'circle' ? obst.cx : (obst.x0 + obst.x1) / 2;
      const by = obst.shape === 'circle' ? obst.cy + obst.r : obst.y1;
      sc.place(label, 'bd-dimtext', cx, by, { dir: [0, 1], near: 4, role: 'dim' });
    } else if (d.type === 'radius') {
      const mid = main.bends[Math.floor(main.bends.length / 2)];
      if (mid) { const [ox, oy] = outside(mid); sc.place(`R ${fmt(d.label)}`, 'bd-dimtext', X(mid.x), Y(mid.y), { dir: [-ox, -oy], near: hw + 4, role: 'dim' }); }
    }
  }
  if (result.kind === 'concentric') {
    finals.forEach((p, i) => {
      const b = p.bends[0];
      if (b) sc.place(`R ${fmt(result.pipes[i].radiusM)}`, 'bd-dimtext', X(b.x), Y(b.y), { dir: outside(b), near: hw + 3, role: 'dim' });
    });
    sc.place(`90° in ${result.shots} shot${result.shots === 1 ? '' : 's'} each`, 'bd-angle', X(geo.minX), Y(geo.maxY), { dir: [0, -1], near: 6, role: 'title' });
  }
  if (obst?.clash) {
    const cx = obst.shape === 'circle' ? obst.cx : (obst.x0 + obst.x1) / 2;
    const ty = obst.shape === 'circle' ? obst.cy - obst.r : obst.y0;
    sc.place('Pipe hits the obstruction', 'bd-warntext', cx, ty, { dir: [0, -1], near: hw + 6, role: 'warning' });
    sc.warnings.push('clash');
  }
  return sc;
}

/** World bounds the view must hold: every pipe point (every frame) and the obstruction. */
function heroGeo(G, od, extraPts) {
  let b = ptsBox(G.finals.flatMap((p) => p.points).concat(extraPts || []), od / 2);
  const w = G.shape;
  if (w) {
    const pipeMaxX = Math.max(...G.finals.flatMap((p) => p.points.map((q) => q[0])));
    b = grow(b, w.shape === 'circle'
      ? { x0: w.cx - w.r, y0: w.cy - w.r, x1: w.cx + w.r, y1: w.cy + w.r }
      : { x0: w.x0, y0: w.y0, x1: Number.isFinite(w.x1) ? w.x1 : pipeMaxX, y1: w.y1 });
  }
  return { minX: b.x0, maxX: b.x1, minY: b.y0, maxY: b.y1, w: Math.max(b.x1 - b.x0, 0.01), h: Math.max(b.y1 - b.y0, 0.002) };
}

/** Lay out the bent pipe; the view fits the pipe, the obstruction and every label. */
function heroLayout(result, { fmt, width, odM, maxHeight }, pipeDrawFor, extraPts, ariaLabel, reveal = null) {
  const od = odM || 0;
  const G = heroGeometry(result, od);
  const geo = heroGeo(G, od, extraPts);
  const avail = width - 2 * MARGIN;
  // start with room around the pipe for dimensions and labels, then shrink until everything fits
  const s0 = Math.max(1, Math.min((avail - 90) / geo.w, (maxHeight - 2 * MARGIN - 50) / geo.h));
  const sc = fitWidth((s) => drawHero(result, G, geo, s, od, fmt, pipeDrawFor(G)), s0, (s) => geo.w * s, avail);
  return finishScene(sc, width, ariaLabel, { reveal });
}

/** The pipe still (finished, or part-formed at `t`), as the shaded tube. */
const stillPipes = (t) => (G) => (sc, P, pipeW) => {
  const all = [];
  for (const d of G.defs) {
    const pts = G.trace(d, t).points.map(P);
    for (const [cls, w] of pipeLayers(pipeW)) sc.draw(poly(pts, cls, w), null, 'pipe');
    all.push(...pts);
  }
  return all;
};

/**
 * The bent pipe, side view, to scale. Returns the laid-out scene: { svg, width, height, viewBox,
 * labels[{ text, cls, box, role }], elements[{ kind, box }], pipes[{ points, halfW }], obstacle }.
 * opts: { fmt(m) -> string, width (px), odM, maxHeight }
 */
export function bentLayout(result, { fmt = mmFmt, width = 640, odM = 0, maxHeight = 340 } = {}) {
  return heroLayout(result, { fmt, width, odM, maxHeight }, stillPipes(1), null, 'Bent pipe, side view, to scale');
}
export const bentSvg = (result, opts) => bentLayout(result, opts).svg;

/**
 * The selected bend, drawn to scale, forming from flat pipe into the finished shape. The pipe
 * polylines animate their points through the computed frames (SMIL, so no script runs in the SVG
 * and it works offline); the dimensions and labels fade in as the shape settles. A persistent
 * arrow shows which way the first bend swings.
 *
 * opts: { fmt, width, odM, maxHeight, reduced, still, frames, durMs }
 *   reduced: draw the finished frame only, no motion (for prefers-reduced-motion).
 *   still:   0..1, draw one static frame at that progress (used to capture stills), no motion.
 * The caller plays it by calling beginElement() on every `.bd-anim` element in the SVG, which also
 * lets a Play/Replay button restart it. With no script run, the SVG rests on the finished shape.
 */
export function animatedBendLayout(result, { fmt = mmFmt, width = 640, odM = 0, maxHeight = 340, reduced = false, still = null, frames = 26, durMs = 1500 } = {}) {
  const opts = { fmt, width, odM, maxHeight };
  if (reduced || still != null) return heroLayout(result, opts, stillPipes(reduced ? 1 : clamp(still, 0, 1)), null, 'Bent pipe, side view, to scale');
  const N = Math.max(2, frames);
  const dur = `${(durMs / 1000).toFixed(2)}s`;
  const frameT = Array.from({ length: N }, (_, i) => easeInOut(i / (N - 1)));
  const G0 = heroGeometry(result, odM || 0);
  // the view holds every frame, so the pipe forms in place without the frame jumping
  const extra = frameT.flatMap((t) => G0.defs.flatMap((d) => G0.trace(d, t).points));
  const animPipes = (G) => (sc, P, pipeW) => {
    const all = [];
    G.defs.forEach((d, pi) => {
      const finalPts = G.finals[pi].points;
      const hasArc = d.segs.some((s) => s.bendDeg != null && s.radiusM);
      // one value per frame; the last is the true finished shape, so the frozen end matches the rest
      const frameVals = frameT.map((t, i) => {
        const raw = i === N - 1 ? finalPts : G.trace(d, t).points;
        const pts = (hasArc ? resample(raw, finalPts.length) : raw).map(P);
        all.push(...pts);
        return ptsAttr(pts);
      });
      const base = frameVals[frameVals.length - 1];
      const values = frameVals.join(';');
      for (const [cls, w] of pipeLayers(pipeW)) {
        sc.draw(`<polyline class="${cls}" stroke-width="${n1(w)}" points="${base}"><animate class="bd-anim" attributeName="points" dur="${dur}" begin="indefinite" fill="freeze" calcMode="linear" values="${values}"/></polyline>`, null, 'pipe');
      }
    });
    return all;
  };
  return heroLayout(result, opts, animPipes, extra, 'Bend forming, side view', dur);
}
export const animatedBendSvg = (result, opts) => animatedBendLayout(result, opts).svg;

// ---------------------------------------------------------------------------
// The straight pipe with its marks
// ---------------------------------------------------------------------------

const SYMBOLS = {
  arrow: (x, y) => `<path class="bd-sym" d="M${n1(x - 6)},${n1(y - 10)} L${n1(x + 6)},${n1(y - 10)} L${n1(x)},${n1(y)} Z"/>`,
  star: (x, y) => {
    const pts = [];
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 3.2 : 7.5, a = (Math.PI / 5) * k - Math.PI / 2;
      pts.push([x + r * Math.cos(a), y - 7 + r * Math.sin(a)]);
    }
    return `<polygon class="bd-sym" points="${ptsAttr(pts)}"/>`;
  },
  notch: (x, y) => `<path class="bd-sym" d="M${n1(x)},${n1(y - 14)} L${n1(x + 6)},${n1(y - 7)} L${n1(x)},${n1(y)} L${n1(x - 6)},${n1(y - 7)} Z"/>`,
  heat: (x, y) => `<path class="bd-sym heat" d="M${n1(x)},${n1(y)} C${n1(x - 7)},${n1(y - 6)} ${n1(x - 2)},${n1(y - 10)} ${n1(x)},${n1(y - 15)} C${n1(x + 2)},${n1(y - 10)} ${n1(x + 7)},${n1(y - 6)} ${n1(x)},${n1(y)} Z"/>`,
  tick: () => '',
};
const SYMBOL_HALF_W = 7.5; // the widest symbol (the star) reaches this far each side of its mark
const SYMBOL_H = 15;
export const SYMBOL_NAMES = { arrow: 'arrow', star: 'star (back of 90)', notch: 'centre-of-bend mark', heat: 'heat', tick: 'reference' };

// A photo of a real conduit hand bender (background removed), drawn hooked on the pipe at each mark
// with the handle hanging straight down — the way the field bend-calc apps show it. w/h are the
// asset's pixel size; handleFrac is where the handle axis sits across the image (so we can line the
// handle up with the mark). Processed from the tool photo into electrical-app/img/bender-emt.png.
const BENDER_IMG = { href: 'img/bender-emt.png', w: 560, h: 542, handleFrac: 0.463 };
// Where each cast reference mark sits across the tool photo (fraction of width), so we can line the
// RIGHT mark up with the pipe mark for each bend: the front-of-bend arrow for offsets/stubs, the
// star ("back of 90") for back-to-backs, the centre-of-bend for a saddle centre.
const BENDER_MARK_FRAC = { arrow: 0.25, star: 0.41, notch: 0.25 };
// and how far down the tool each mark sits (fraction of height), for the guide line from the pipe
const BENDER_MARK_YFRAC = { arrow: 0.2, star: 0.12, notch: 0.2 };

/** One short line telling which cast mark on the bender to line up for this bend (arrow/star/teardrop). */
function benderCallout(result) {
  switch (result.kind) {
    case 'saddle3':
    case 'saddle4':
      return "Saddle: line the tool's “center of bend” (teardrop/notch) mark up at the centre mark, the arrow at the others.";
    case 'backToBack':
      return "Back-to-back: use the tool's star (“back of 90”) mark at mark 2, the arrow at mark 1.";
    case 'stub90':
      return "Stub: line the tool's arrow up with the mark and bend to 90°.";
    default:
      return "Line the tool's arrow mark up with each mark, bend to the angle shown.";
  }
}

/** Break text into lines no wider than `maxW` px. */
function wrapText(str, cls, maxW) {
  const lines = [];
  let cur = '';
  for (const w of String(str).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, cls) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Spread label blocks along a row so none overlap, each as close to its mark as it can be and in
 * the same order as the marks (so leader lines never cross). items: [{ ideal, w }] sorted by ideal;
 * sets item.cx. The row stays within lo..hi where there is room.
 */
function packRow(items, gap, lo, hi) {
  const clusters = [];
  for (const it of items) {
    clusters.push({ items: [it], w: it.w, left: it.ideal - it.w / 2 });
    while (clusters.length > 1) {
      const a = clusters[clusters.length - 2], b = clusters[clusters.length - 1];
      if (a.left + a.w + gap <= b.left) break;
      const merged = { items: [...a.items, ...b.items], w: a.w + gap + b.w };
      // the best left edge: the average of where each item would like the cluster to start
      let off = 0, sum = 0;
      for (const m of merged.items) { sum += m.ideal - m.w / 2 - off; off += m.w + gap; }
      merged.left = sum / merged.items.length;
      clusters.splice(clusters.length - 2, 2, merged);
    }
  }
  const lefts = [];
  for (const c of clusters) { let x = c.left; for (const m of c.items) { lefts.push(x); x += m.w + gap; } }
  for (let i = 0; i < items.length; i++) lefts[i] = Math.max(lefts[i], i ? lefts[i - 1] + items[i - 1].w + gap : lo);
  for (let i = items.length - 1; i >= 0; i--) lefts[i] = Math.min(lefts[i], i < items.length - 1 ? lefts[i + 1] - gap - items[i].w : hi - items[i].w);
  for (let i = 1; i < items.length; i++) lefts[i] = Math.max(lefts[i], lefts[i - 1] + items[i - 1].w + gap);
  items.forEach((it, i) => { it.cx = lefts[i] + it.w / 2; });
}

/** A stack of text lines (top to bottom) centred on cx, its bottom at `bottom`. */
function drawStack(sc, cx, bottom, lines, role) {
  let y = bottom;
  for (let i = lines.length - 1; i >= 0; i--) {
    const [str, cls] = lines[i];
    const size = sizeOf(cls);
    sc.text(cx, y - 0.22 * size, str, cls, 'middle', role);
    y -= size + 2;
  }
}
const stackHeight = (lines) => lines.reduce((s, [, cls]) => s + sizeOf(cls) + 2, 0) - 2;
const stackWidth = (lines) => Math.max(...lines.map(([str, cls]) => textWidth(str, cls)));

/** The label stack for one mark, top to bottom: number · angle, note, distance. */
function markLines(m, fmt, snap) {
  const tag = [shortTag(m), m.angleDeg ? fmtDeg(m.angleDeg) : ''].filter(Boolean).join(' · ');
  const lines = [];
  if (tag) lines.push([tag, 'bd-marktag']);
  if (m.note) lines.push([m.note, 'bd-note']);
  lines.push([fmt(snap(m.atM)), 'bd-pos']);
  return lines;
}

/** The mark layout at `k` px per metre of pipe. */
function drawStrip(result, rows, o, k) {
  const { fmt, snap, shift, tail, last, spread, compress, fromMark1 } = o;
  const sc = new Scene();
  const X0 = (atM) => (atM - shift) * k;
  const pipeH = 16;
  let y = 0;
  for (const row of rows) {
    const marks = [...row.marks].sort((a, b) => a.atM - b.atM);
    // many shots get the short form: tags on the first and the reference marks, positions below
    const dense = marks.length > 6;
    if (row.title) { sc.text(0, y + 12, row.title, 'bd-rowtitle', 'start', 'title'); y += 18; }
    // marks closer than a symbol's width are spread just enough to tell apart (the numbers stay true)
    const minGap = dense ? 10 : 2 * SYMBOL_HALF_W + 2;
    const xs = [];
    marks.forEach((m, i) => { const x = X0(m.atM); xs.push(i && m.atM > marks[i - 1].atM + 1e-9 ? Math.max(x, xs[i - 1] + minGap) : i ? Math.max(x, xs[i - 1]) : x); });
    const xOf = new Map(marks.map((m, i) => [m, xs[i]]));
    const stretch = xs.length ? xs[xs.length - 1] - X0(marks[marks.length - 1].atM) : 0;
    const barEnd = X0(last) + Math.max(0, stretch) + tail * k;

    // above the pipe, what you need to KNOW for each mark (number · angle, note, distance), in one row
    const blocks = [];
    const firstAngle = marks.find((q) => q.angleDeg);
    if (!fromMark1) blocks.push({ lines: [['END', 'bd-endtext']], end: true, x: 0 });
    for (const m of marks) {
      const tag = [shortTag(m), m.angleDeg ? fmtDeg(m.angleDeg) : ''].filter(Boolean).join(' · ');
      if (dense) {
        if ((m.symbol === 'tick' || m === firstAngle) && tag) blocks.push({ lines: [[tag, 'bd-marktag']], x: xOf.get(m) });
        continue;
      }
      blocks.push({ lines: markLines(m, fmt, snap), x: xOf.get(m) });
    }
    for (const b of blocks) { b.w = stackWidth(b.lines); b.h = stackHeight(b.lines); b.ideal = b.end ? b.w / 2 : b.x; }
    blocks.sort((a, b) => a.ideal - b.ideal);
    // One row of labels when they fit across. If not, every other mark's label goes up a tier, and
    // its leader climbs through the gap between the labels of its neighbours below, so no leader
    // crosses a label or another leader.
    const rowW = blocks.reduce((w, b) => w + b.w + 8, -8);
    const upper = !dense && rowW > o.textW - 24 ? blocks.filter((b) => !b.end).filter((_, i) => i % 2 === 1) : [];
    const lower = blocks.filter((b) => !upper.includes(b));
    packRow(lower, 8, -12, barEnd + 12);
    for (const b of upper) {
      const at = blocks.indexOf(b);
      const prev = blocks.slice(0, at).reverse().find((q) => !upper.includes(q));
      const next = blocks.slice(at + 1).find((q) => !upper.includes(q));
      b.gx = prev && next ? (prev.cx + prev.w / 2 + next.cx - next.w / 2) / 2 : prev ? prev.cx + prev.w / 2 + 6 : next.cx - next.w / 2 - 6;
      b.ideal = b.gx;
    }
    packRow(upper, 8, -12, barEnd + 12);
    // when labels had to slide along, every label gets a leader down to its mark
    const lead = upper.length || lower.some((b) => !b.end && Math.abs(b.cx - b.x) > 1.5) ? 14 : 0;
    const lowH = Math.max(0, ...lower.map((b) => b.h));
    const upH = upper.length ? Math.max(...upper.map((b) => b.h)) + 12 : 0;
    const pipeY = y + upH + lowH + lead + SYMBOL_H + 5;
    const rowBottom = pipeY - SYMBOL_H - 3 - lead;
    const upBottom = rowBottom - lowH - 12;

    // pipe body as a shaded bar (dark edge, mid body, light highlight band) to match the hero tube
    const barW = n1(barEnd);
    sc.draw(`<rect class="bd-pipebar-edge" x="0" y="${n1(pipeY)}" width="${barW}" height="${pipeH}" rx="3"/>`
      + `<rect class="bd-pipebar-body" x="0" y="${n1(pipeY + 1.5)}" width="${barW}" height="${n1(pipeH - 3)}" rx="2"/>`
      + `<rect class="bd-pipebar-hi" x="0" y="${n1(pipeY + 2)}" width="${barW}" height="${n1(Math.max(2, pipeH * 0.28))}" rx="2"/>`,
    { x0: 0, y0: pipeY, x1: barEnd, y1: pipeY + pipeH }, 'fg', 'pipe');
    const startM = marks.find((m) => /^(Start of|Pipe \d+ start)/.test(m.label));
    const endM = marks.find((m) => /(End of|end of bend)/.test(m.label));
    if (endM) {
      const sx = startM ? xOf.get(startM) : X0(result.startM ?? endM.atM);
      sc.draw(`<rect class="${marks.some((m) => m.symbol === 'heat') ? 'bd-heatzone' : 'bd-bendzone'}" x="${n1(sx)}" y="${n1(pipeY)}" width="${n1(Math.max(1, xOf.get(endM) - sx))}" height="${pipeH}"/>`, null);
    }
    if (!fromMark1) sc.draw(line(0, pipeY - 6, 0, pipeY + pipeH + 6, 'bd-endcap'), { x0: -2, y0: pipeY - 8, x1: 2, y1: pipeY + pipeH + 8 }, 'fg', 'end');
    else { const b = breakMark(0.07 * spread * k, pipeY + pipeH / 2, 0, pipeH); sc.draw(b.svg, b.box, 'fg', 'break'); }
    if (compress) { const b = breakMark(shift > 0 ? 0.22 * spread * k : 0, pipeY + pipeH / 2, 0, pipeH); sc.draw(b.svg, b.box, 'fg', 'break'); }

    for (const m of marks) {
      const x = xOf.get(m);
      sc.draw(line(x, pipeY - 2, x, pipeY + pipeH + 2, m.symbol === 'tick' ? 'bd-tick' : 'bd-markline'), { x0: x - 1.5, y0: pipeY - 2, x1: x + 1.5, y1: pipeY + pipeH + 2 }, 'fg', 'markline');
      if (m.symbol && m.symbol !== 'tick') sc.draw(SYMBOLS[m.symbol](x, pipeY - 2), { x0: x - SYMBOL_HALF_W, y0: pipeY - 2 - SYMBOL_H, x1: x + SYMBOL_HALF_W, y1: pipeY - 2 }, 'fg', 'symbol');
    }
    const y1 = pipeY - SYMBOL_H - 3;
    for (const b of lower) {
      drawStack(sc, b.cx, rowBottom, b.lines, b.end ? 'end' : 'mark');
      if (!b.end && lead) sc.draw(line(b.x, y1, b.cx, rowBottom + 1, 'bd-leader'), ptsBox([[b.x, y1], [b.cx, rowBottom + 1]]), 'fg', 'leader');
    }
    for (const b of upper) {
      drawStack(sc, b.cx, upBottom, b.lines, 'mark');
      const pts = [[b.x, y1], [b.gx, rowBottom + 1], [b.gx, rowBottom - lowH - 1], [b.cx, upBottom + 1]];
      sc.draw(`<polyline class="bd-leader" points="${ptsAttr(pts)}"/>`, ptsBox(pts), 'fg', 'leader');
    }

    if (dense) {
      // many shots: the first, second and last positions and the reference marks, below the pipe
      const pick = marks.filter((m, i) => i === 0 || i === 1 || i === marks.length - 1 || m.symbol === 'tick');
      const below = pick.map((m) => { const str = fmt(snap(m.atM)); return { x: xOf.get(m), ideal: xOf.get(m), str, w: textWidth(str, 'bd-pos') }; });
      packRow(below, 8, -12, barEnd + 12);
      const moved = below.some((b) => Math.abs(b.cx - b.x) > 1.5);
      const top = pipeY + pipeH + 4 + (moved ? 12 : 0);
      for (const b of below) {
        sc.text(b.cx, top + 0.78 * sizeOf('bd-pos'), b.str, 'bd-pos', 'middle', 'mark');
        if (moved) sc.draw(line(b.x, pipeY + pipeH + 3, b.cx, top - 1, 'bd-leader'), ptsBox([[b.x, pipeY + pipeH + 3], [b.cx, top - 1]]), 'fg', 'leader');
      }
      y = top + sizeOf('bd-pos') + 4;
      const shots = marks.filter((m) => m.angleDeg);
      if (shots.length > 1) { sc.text(0, y + 12, `${shots.length} marks, every ${fmt(shots[1].atM - shots[0].atM)}`, 'bd-dimtext', 'start', 'note'); y += 18; }
    } else {
      // a real hand-bender photo hooked on each bend mark, handle hanging down, like the field apps
      const benderMarks = marks.filter((m) => ['arrow', 'star', 'notch'].includes(m.symbol) && m.angleDeg);
      y = pipeY + pipeH + 8;
      if (benderMarks.length) {
        // where each tool's mark sits across its photo (mirrored for a flipped tool)
        const fracOf = (m) => { const f = BENDER_MARK_FRAC[m.symbol] ?? BENDER_IMG.handleFrac; return m.dir === 'down' ? 1 - f : f; };
        // as big as fits between neighbours, within sensible bounds; a tool that would still
        // overlap its neighbour hangs a row lower, so no two tools ever cover each other
        let fit = 110;
        for (let i = 1; i < benderMarks.length; i++) {
          const a = benderMarks[i - 1], b = benderMarks[i];
          fit = Math.min(fit, (xOf.get(b) - xOf.get(a) - 4) / (1 - fracOf(a) + fracOf(b)));
        }
        const dispW = clamp(fit, 44, 110);
        const dispH = (dispW * BENDER_IMG.h) / BENDER_IMG.w;
        const top0 = pipeY + pipeH - dispH * 0.06; // the head tucks just under the pipe
        const img = `<image class="bd-tool-img" href="${BENDER_IMG.href}" x="0" y="0" width="${n1(dispW)}" height="${n1(dispH)}" preserveAspectRatio="xMidYMid meet"/>`;
        const laneEnds = [];
        const tools = benderMarks.map((m) => {
          // a 'down' bend is the mirror of an 'up' one (the pipe is rolled 180°, or bent the other
          // way), so flip the tool for it — the saddle centre, the offset's far bend, etc.
          const x = xOf.get(m);
          const flip = m.dir === 'down';
          const x0 = x - fracOf(m) * dispW;
          let lane = laneEnds.findIndex((end) => end + 4 <= x0);
          if (lane < 0) { lane = laneEnds.length; laneEnds.push(-Infinity); }
          laneEnds[lane] = x0 + dispW;
          const top = top0 + lane * (dispH + 6);
          return { x, x0, flip, top, my: top + (BENDER_MARK_YFRAC[m.symbol] ?? 0.2) * dispH };
        });
        // guide lines behind the tools: from the pipe mark down to that cast mark — "the bend happens here"
        for (const t of tools) sc.draw(line(t.x, pipeY + pipeH, t.x, t.my, 'bd-tool-guide'), null);
        for (const t of tools) {
          sc.draw(t.flip
            ? `<g transform="translate(${n1(t.x0 + dispW)},${n1(t.top)}) scale(-1,1)">${img}</g>`
            : `<g transform="translate(${n1(t.x0)},${n1(t.top)})">${img}</g>`, { x0: t.x0, y0: t.top, x1: t.x0 + dispW, y1: t.top + dispH }, 'fg', 'tool');
          sc.draw(`<circle class="bd-tool-guide-dot" cx="${n1(t.x)}" cy="${n1(t.my)}" r="2.4"/>`, null);
        }
        y = top0 + laneEnds.length * (dispH + 6);
        // which cast mark to use, wrapped to the width so it is never cut off
        for (const ln of wrapText(benderCallout(result), 'bd-callout', o.textW)) { sc.text(barEnd / 2, y + 9, ln, 'bd-callout', 'middle', 'callout'); y += 14; }
      }
    }
    y += 12;
  }
  return sc;
}

/**
 * The straight pipe with its marks, measured from the reference end. Returns the laid-out scene
 * (see bentLayout). opts: { fmt(m), snap(m) (round to what a tape reads), width }
 */
export function marksLayout(result, { fmt = mmFmt, snap = (m) => m, width = 640 } = {}) {
  const rows = result.pipes
    ? result.pipes.map((p) => ({ title: `Pipe ${p.index}`, marks: result.marks.filter((m) => m.pipe === p.index) }))
    : [{ title: null, marks: result.marks }];
  const allAt = rows.flatMap((r) => r.marks.map((m) => m.atM));
  const first = Math.min(...allAt), last = Math.max(...allAt);
  const spread = Math.max(last - first, 0.05);
  const fromMark1 = result.reference === 'mark1';
  const compress = !fromMark1 && first > 1.5 * spread && first > 0.3;
  const shift = compress ? first - 0.45 * spread : fromMark1 ? -0.15 * spread : 0;
  const tail = Math.max(spread * 0.15, 0.04);
  const xMax = last - shift + tail;
  const avail = width - 2 * MARGIN;
  const o = { fmt, snap, shift, tail, last, spread, compress, fromMark1, textW: avail };
  const sc = fitWidth((k) => drawStrip(result, rows, o, k), Math.max(1, (avail - 24) / xMax), (k) => xMax * k, avail);
  return finishScene(sc, width, 'Straight pipe with the bend marks');
}
export const marksSvg = (result, opts) => marksLayout(result, opts).svg;

// ---------------------------------------------------------------------------
// Rolling offset, end view
// ---------------------------------------------------------------------------

/** End view of a rolling offset: rise, roll and the true offset. */
export function rollLayout(result, { fmt = mmFmt, size = 200 } = {}) {
  const { riseM, rollM, trueM, rollDeg } = result.endView;
  const m = Math.max(riseM, rollM, 0.001);
  const s = (size - 70) / m;
  const x0 = 40, y0 = size - 30;
  const x1 = x0 + rollM * s, y1 = y0 - riseM * s;
  const up = Math.min(size - 50, Math.max(riseM * s, 60));
  const r = 34, a = (rollDeg * Math.PI) / 180;
  const sc = new Scene();
  const seg = (xa, ya, xb, yb, cls) => { sc.draw(line(xa, ya, xb, yb, cls), ptsBox([[xa, ya], [xb, yb]], 2), 'fg', 'line'); sc.keepClearSeg(xa, ya, xb, yb, 2); };
  seg(x0, y0, x0, y0 - up, 'bd-tick');
  const arc = Array.from({ length: 9 }, (_, i) => { const t = (a * i) / 8; return [x0 + r * Math.sin(t), y0 - r * Math.cos(t)]; });
  sc.draw(`<path class="bd-dim" fill="none" d="M${x0},${y0 - r} A${r},${r} 0 0 1 ${n1(x0 + r * Math.sin(a))},${n1(y0 - r * Math.cos(a))}"/>`, ptsBox(arc, 1), 'fg', 'line');
  sc.keepClearLine(arc, 1);
  seg(x0, y0, x1, y0, 'bd-dim');
  seg(x1, y0, x1, y1, 'bd-dim');
  seg(x0, y0, x1, y1, 'bd-true');
  for (const [cx, cy] of [[x0, y0], [x1, y1]]) {
    const b = { x0: cx - 6, y0: cy - 6, x1: cx + 6, y1: cy + 6 };
    sc.draw(`<circle class="bd-end" cx="${n1(cx)}" cy="${n1(cy)}" r="5"/>`, b, 'fg', 'end');
    sc.keepClear(b);
  }
  sc.place(`true ${fmt(trueM)}`, 'bd-angle', (x0 + x1) / 2, (y0 + y1) / 2, { dir: [-Math.cos(a), -Math.sin(a)], near: 4, role: 'dim' });
  sc.place(`roll ${fmt(rollM)}`, 'bd-dimtext', (x0 + x1) / 2, y0, { dir: [0, 1], near: 4, role: 'dim' });
  sc.place(`rise ${fmt(riseM)}`, 'bd-dimtext', x1, (y0 + y1) / 2, { dir: [1, 0], near: 6, role: 'dim' });
  sc.place('up', 'bd-note', x0, y0 - up, { dir: [0, -1], near: 3 });
  sc.place(`${fmtDeg(rollDeg)} from up`, 'bd-note', x0 + r * Math.sin(a / 2), y0 - r * Math.cos(a / 2), { dir: [Math.sin(a / 2), -Math.cos(a / 2)], near: 4 });
  // as wide as its labels need, so nothing is scaled down
  const w = Math.max(size + 60, Math.ceil(sc.bounds.x1 - sc.bounds.x0 + 2 * MARGIN));
  return finishScene(sc, w, 'End view of the rolling offset', { cls: 'bend-svg roll' });
}
export const rollSvg = (result, opts) => rollLayout(result, opts).svg;

export { FONT };
