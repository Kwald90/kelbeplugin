// Bend diagrams as SVG strings: the bent pipe drawn to scale, and the straight pipe with its
// marks. Pure (no DOM), so the screen, the print sheet and the tests share one renderer.
// Colours come from CSS classes in css/bending.css (tokens only).
import { tracePath, fmtDeg } from './bending.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v) => Math.round(v * 10) / 10;
const mmFmt = (m) => `${Math.round(m * 1000)} mm`;
const PAD = 36;
const FONT = 12;

function text(x, y, s, cls = 'bd-text', anchor = 'middle', extra = '') {
  return `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;
}
function line(x1, y1, x2, y2, cls) {
  return `<line class="${cls}" x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}"/>`;
}
const poly = (pts, cls, w) => `<polyline class="${cls}" points="${pts.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ')}"${w ? ` stroke-width="${n1(w)}"` : ''}/>`;

/** A dimension line with end ticks and a label in the middle. */
function dim(x1, y1, x2, y2, label, side = 'right', lineCls = 'bd-dim', textCls = 'bd-dimtext') {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
  const t = 5;
  const ticks = vertical
    ? line(x1 - t, y1, x1 + t, y1, lineCls) + line(x2 - t, y2, x2 + t, y2, lineCls)
    : line(x1, y1 - t, x1, y1 + t, lineCls) + line(x2, y2 - t, x2, y2 + t, lineCls);
  const lab = vertical
    ? (side === 'left' ? text(mx - 8, my + 4, label, textCls, 'end') : text(mx + 8, my + 4, label, textCls, 'start'))
    : text(mx, my - 6, label, textCls);
  return line(x1, y1, x2, y2, lineCls) + ticks + lab;
}

/** Two slanted lines across the pipe: this stretch is not drawn to scale. */
function breakMark(x, y, angleDeg, size) {
  const a = (angleDeg * Math.PI) / 180;
  const nx = -Math.sin(a), ny = -Math.cos(a); // screen normal (y down)
  const tx = Math.cos(a), ty = -Math.sin(a);
  const h = size / 2 + 6;
  const g = 4;
  const seg = (o) => line(x + tx * o - nx * h + tx * 3, y + ty * o - ny * h + ty * 3, x + tx * o + nx * h - tx * 3, y + ty * o + ny * h - ty * 3, 'bd-break');
  const gap = `<polygon class="bd-gap" points="${[
    [x - tx * g - nx * h, y - ty * g - ny * h], [x + tx * g - nx * h, y + ty * g - ny * h],
    [x + tx * g + nx * h, y + ty * g + ny * h], [x - tx * g + nx * h, y - ty * g + ny * h],
  ].map(([px, py]) => `${n1(px)},${n1(py)}`).join(' ')}"/>`;
  return gap + seg(-g) + seg(g);
}

// Shorten a long lead-in or tail so the bends stay readable; the dimensions keep true values.
function capSegments(segments, startHeading, leadIn = false) {
  const segs = segments.map((s) => ({ ...s }));
  const breaks = [];
  if (segs.length < 3) return { segs, breaks };
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
  return { segs, breaks };
}

/**
 * The pipe segment lists to draw for a result, before tracing: [{ segs, start, main, breaks }].
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
      out.push({ segs, start: { x: 0, y: -(p.index - 1) * result.centersM }, main: p.index === 1, breaks: lead < result.startM ? ['first'] : [] });
    }
    return out;
  }
  if (result.kind === 'parallel') {
    const cap = capSegments(result.segments, 0, result.reference === 'mark1');
    const cut = result.segments[0].straightM - cap.segs[0].straightM; // negative when a lead-in was added
    for (const p of result.pipes) {
      const [a, b] = p.marks;
      const segs = [{ straightM: a.atM - cut }, { bendDeg: result.angleDeg }, { straightM: b.atM - a.atM }, { bendDeg: -result.angleDeg }, { straightM: cap.segs[cap.segs.length - 1].straightM }];
      out.push({ segs, start: { x: 0, y: -(p.index - 1) * result.centersM }, main: p.index === 1, breaks: cap.breaks });
    }
    return out;
  }
  const cap = capSegments(result.segments, startH, result.reference === 'mark1');
  out.push({ segs: cap.segs, start: result.start, main: true, breaks: cap.breaks });
  return out;
}

/** Trace a segment list with every bend scaled by `t` (0 = flat pipe, 1 = the finished bend). */
function traceScaled(segs, start, t) {
  return tracePath(segs.map((s) => (s.bendDeg != null ? { ...s, bendDeg: s.bendDeg * t } : s)), start);
}

/** The pipes to draw for a result, in metres: [{ path, main, breaks }]. */
function pipesFor(result) {
  return pipeSegsFor(result).map((d) => ({ path: tracePath(d.segs, d.start), main: d.main, breaks: d.breaks }));
}

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

/**
 * Work out the drawing transform for a result.
 * `bboxPts` (optional) are extra world points the view must contain (the animation frames), so the
 * frame stays put while the pipe forms. Returns the transform and the key geometry for the parts.
 */
function layoutFor(result, pipes, od, { width, maxHeight }, bboxPts) {
  const main = pipes.find((p) => p.main).path;
  const shapes = []; // world-space extras for the bounding box: [x, y]
  const all = pipes.flatMap((p) => p.path.points);
  const lowest = Math.min(...all.map((p) => p[1]));
  const dims = result.dims || [];
  const obstacle = dims.find((d) => d.type === 'obstacle');
  const step = dims.find((d) => d.type === 'rise' && d.obstacle);
  if (obstacle?.round) {
    const apex = main.bends[1];
    shapes.push([apex.x - obstacle.heightM / 2, -od / 2], [apex.x + obstacle.heightM / 2, -od / 2 + obstacle.heightM]);
  }
  const box = bboxPts && bboxPts.length ? bboxPts : all;
  let minX = Math.min(...box.map((p) => p[0])) - od / 2, maxX = Math.max(...box.map((p) => p[0])) + od / 2;
  let minY = Math.min(...box.map((p) => p[1])) - od / 2, maxY = Math.max(...box.map((p) => p[1])) + od / 2;
  for (const [x, y] of shapes) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const wM = Math.max(maxX - minX, 0.01), hM = Math.max(maxY - minY, 0.002);
  const left = PAD + 30, right = PAD + 56, top = PAD, bottom = PAD + 20;
  let s = (width - left - right) / wM;
  let height = hM * s + top + bottom;
  if (height > maxHeight) { s = (maxHeight - top - bottom) / hM; height = maxHeight; }
  height = Math.max(height, 150);
  const offX = left + ((width - left - right) - wM * s) / 2;
  const offY = top + ((height - top - bottom) - hM * s) / 2;
  const X = (x) => offX + (x - minX) * s;
  const Y = (y) => offY + (maxY - y) * s;
  const P = ([x, y]) => [X(x), Y(y)];
  const pipeW = Math.max(9, od * s * 1.1); // bold enough to read as a tube, not a wire
  return { main, dims, obstacle, step, lowest, minX, maxX, minY, maxY, s, X, Y, P, pipeW, height };
}

/** The surface line and the obstruction (drawn behind the pipe). */
function backgroundParts(result, L, od) {
  const parts = [];
  const { X, Y, s, pipeW, minX, maxX, lowest, main, obstacle, step } = L;
  if (['offset', 'saddle3', 'saddle4', 'boxOffset', 'rolling', 'parallel'].includes(result.kind)) {
    parts.push(line(X(minX), Y(lowest - od / 2), X(maxX), Y(lowest - od / 2), 'bd-surface'));
  }
  if (obstacle?.round) {
    const apex = main.bends[1];
    const r = (obstacle.heightM / 2) * s;
    parts.push(`<circle class="bd-obst" cx="${n1(X(apex.x))}" cy="${n1(Y(-od / 2) - r)}" r="${n1(Math.max(r, 2))}"/>`);
  } else if (obstacle && main.bends.length >= 3) {
    const x1 = X(main.bends[1].x), x2 = X(main.bends[2].x);
    parts.push(`<rect class="bd-obst" x="${n1(x1)}" y="${n1(Y(-od / 2 + obstacle.heightM))}" width="${n1(Math.max(2, x2 - x1))}" height="${n1(Math.max(2, obstacle.heightM * s))}"/>`);
  } else if (step && main.bends.length >= 2) {
    const b = main.bends[1];
    const x1 = X(b.x) + pipeW, x2 = X(maxX);
    if (x2 - x1 > 8) parts.push(`<rect class="bd-obst" x="${n1(x1)}" y="${n1(Y(b.y - od / 2))}" width="${n1(x2 - x1)}" height="${n1(Math.max(2, Y(-od / 2) - Y(b.y - od / 2)))}"/>`);
  }
  return parts;
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

/** The pipe as a shaded tube, static. */
function pipePolys(pipes, L) {
  const parts = [];
  for (const p of pipes) {
    const pts = p.path.points.map(L.P);
    for (const [cls, w] of pipeLayers(L.pipeW)) parts.push(poly(pts, cls, w));
  }
  return parts;
}

/** Break marks on a shortened lead-in or tail (the stretch not drawn to scale). */
function breakParts(pipes, L) {
  const parts = [];
  for (const p of pipes) {
    const pts = p.path.points.map(L.P);
    if (p.breaks.includes('first') && pts.length > 1) {
      const [a, b] = [pts[0], pts[1]];
      parts.push(breakMark((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, L.pipeW));
    }
    if (p.breaks.includes('last') && pts.length > 1) {
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
      parts.push(breakMark((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, L.pipeW));
    }
  }
  return parts;
}

/** The reference-end marker, the bend-angle labels and the dimensions (drawn over the pipe). */
function foregroundParts(result, L, od, fmt, pipes) {
  const parts = [];
  const { X, Y, s, pipeW, minX, maxX, lowest, main, dims } = L;
  const [ex, ey] = L.P(main.points[0]);
  if (result.reference !== 'mark1') {
    parts.push(`<circle class="bd-end" cx="${n1(ex)}" cy="${n1(ey)}" r="${n1(Math.min(7, Math.max(3, pipeW / 2)))}"/>`);
    parts.push(text(ex, ey - pipeW / 2 - 8, 'END', 'bd-endtext'));
  }
  const bendMarks = result.marks.filter((m) => m.angleDeg && (!m.pipe || m.pipe === 1));
  if (result.kind === 'concentric') {
    parts.push(text(PAD, PAD - 10, `90° in ${result.shots} shot${result.shots === 1 ? '' : 's'} each`, 'bd-angle', 'start'));
  } else if (result.kind === 'segment') {
    const mid = main.bends[Math.floor(main.bends.length / 2)];
    if (mid) parts.push(text(X(mid.x) + 14, Y(mid.y) + 14, `${fmtDeg(result.angleDeg ?? 90)} in ${result.shots} shots`, 'bd-angle', 'start'));
  } else {
    main.bends.forEach((b, i) => {
      const m = bendMarks[i];
      const hh = (b.headingDeg * Math.PI) / 180;
      const sign = Math.sign(b.bendDeg) || 1;
      const ox = Math.sin(hh) * sign, oy = Math.cos(hh) * sign;
      const d = pipeW / 2 + 16 + (result.kind === 'parallel' && b.bendDeg > 0 ? (result.count - 1) * result.centersM * s : 0);
      const x = X(b.x) + ox * d, y = Y(b.y) + oy * d + 4;
      const label = [m ? shortTag(m) : '', fmtDeg(Math.abs(b.bendDeg))].filter(Boolean).join(' · ');
      parts.push(text(x, y, label, 'bd-angle'));
    });
  }
  const gap = pipeW / 2 + 14;
  for (const d of dims) {
    if (d.type === 'rise' && main.bends.length >= 2) {
      const yA = main.points[0][1], yB = main.bends[1].y;
      const x = X(maxX) + 12;
      parts.push(dim(x, Y(yA), x, Y(yB), fmt(d.label), 'right', 'bd-dim-rise', 'bd-risetext'));
    } else if (d.type === 'kick' && main.bends.length) {
      const x = X(minX) - 14;
      parts.push(dim(x, Y(0), x, Y(main.bends[0].y), fmt(d.label), 'left', 'bd-dim-rise', 'bd-risetext'));
    } else if (d.type === 'stub') {
      const x = X(minX) - 14;
      parts.push(dim(x, Y(0), x, Y(lowest - od / 2), fmt(d.label), 'left', 'bd-dim-rise', 'bd-risetext'));
    } else if (d.type === 'leg' || d.type === 'backToBack') {
      const y = Y(lowest - od / 2) + gap;
      parts.push(dim(X(-od / 2), y, X(main.end[0] + (d.type === 'backToBack' ? od / 2 : 0)), y, fmt(d.label)));
    } else if (d.type === 'obstacle') {
      const label = d.round ? fmt(d.heightM) : `${fmt(d.heightM)} × ${fmt(d.widthM)}`;
      const b = main.bends[1];
      if (b) parts.push(text(X(b.x) + (d.round ? 0 : ((main.bends[2]?.x ?? b.x) - b.x) * s / 2), Y(-od / 2) + 16, label, 'bd-dimtext'));
    } else if (d.type === 'radius') {
      const mid = main.bends[Math.floor(main.bends.length / 2)];
      if (mid) parts.push(text(X(mid.x) - 10, Y(mid.y) - 10, `R ${fmt(d.label)}`, 'bd-dimtext', 'end'));
    }
  }
  if (result.kind === 'concentric') {
    for (const p of pipes) {
      const b = p.path.bends[0];
      if (b) parts.push(text(X(b.x) + 10, Y(b.y) + 4, `R ${fmt(result.pipes[pipes.indexOf(p)].radiusM)}`, 'bd-dimtext', 'start'));
    }
  }
  return parts;
}

/** A curved arrow at the first bend showing which way the leg swings — "face the bender this way". */
function directionArrow(L) {
  const b0 = L.main.bends[0];
  if (!b0 || !b0.bendDeg) return '';
  const cx = L.X(b0.x), cy = L.Y(b0.y);
  const r = L.pipeW / 2 + 12;
  const a0 = -((b0.headingDeg - b0.bendDeg / 2) * Math.PI) / 180; // screen angle (y flips)
  const a1 = -((b0.headingDeg + b0.bendDeg / 2) * Math.PI) / 180;
  const steps = 10;
  const pts = [];
  for (let k = 0; k <= steps; k++) { const a = a0 + ((a1 - a0) * k) / steps; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  const [hx, hy] = pts[steps];
  const [px, py] = pts[steps - 1];
  const ang = Math.atan2(hy - py, hx - px);
  const ah = 5.5;
  const head = `<path class="bd-dir" d="M${n1(hx)},${n1(hy)} L${n1(hx - ah * Math.cos(ang - 0.5))},${n1(hy - ah * Math.sin(ang - 0.5))} M${n1(hx)},${n1(hy)} L${n1(hx - ah * Math.cos(ang + 0.5))},${n1(hy - ah * Math.sin(ang + 0.5))}"/>`;
  return poly(pts, 'bd-dir') + head;
}

const svgWrap = (width, height, label, inner, vb) => {
  // Default view stays byte-identical to the un-tooled diagram (integer box at the origin). Only a
  // grown box (to contain the bender's handle) uses an offset/rounded view.
  const vbStr = vb ? `${Math.round(vb.x)} ${Math.round(vb.y)} ${Math.round(vb.w)} ${Math.round(vb.h)}` : `0 0 ${width} ${Math.round(height)}`;
  const w = vb ? Math.round(vb.w) : width, h = vb ? Math.round(vb.h) : Math.round(height);
  return `<svg class="bend-svg" viewBox="${vbStr}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
};

/** Grow a [0,0,width,height] box to contain an extra {minx,miny,maxx,maxy}, with a small margin. */
function viewBoxWith(width, height, bbox, m = 5) {
  if (!bbox) return null;
  const x = Math.min(0, bbox.minx - m), y = Math.min(0, bbox.miny - m);
  const maxX = Math.max(width, bbox.maxx + m), maxY = Math.max(height, bbox.maxy + m);
  return { x, y, w: maxX - x, h: maxY - y };
}

/** Gradients and a soft-shadow blur for the shaded bender (identical per SVG, so an id clash resolves the same). */
function benderDefs() {
  return '<defs>'
    + '<linearGradient id="bdShoe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#aeb6bf"/><stop offset="0.45" stop-color="#6b747e"/><stop offset="1" stop-color="#394049"/></linearGradient>'
    + '<radialGradient id="bdHead" cx="0.4" cy="0.35" r="0.85"><stop offset="0" stop-color="#c7ced6"/><stop offset="0.55" stop-color="#7d8791"/><stop offset="1" stop-color="#454c55"/></radialGradient>'
    + '<linearGradient id="bdGroove" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22272d"/><stop offset="1" stop-color="#58616b"/></linearGradient>'
    + '<linearGradient id="bdHandle" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e7b654"/><stop offset="0.5" stop-color="#c0892b"/><stop offset="1" stop-color="#7f5a16"/></linearGradient>'
    + '<filter id="bdSoft" x="-20%" y="-30%" width="140%" height="170%"><feGaussianBlur stdDeviation="2.2"/></filter>'
    + '</defs>';
}

/** Which mark of the shoe the bend is made on, and its label. */
function benderMark(kind) {
  if (kind === 'backToBack') return { shape: 'star', label: 'star' };
  if (kind === 'saddle3' || kind === 'saddle4') return { shape: 'notch', label: 'notch' };
  return { shape: 'arrow', label: 'arrow' };
}

/**
 * A compact 2.5D hand bender tucked into the crook of the first bend, drawn BEHIND the pipe so the
 * bent pipe is never buried: a round cast head (shoe) whose groove the pipe sits in, a hook lip that
 * catches the pipe, a pivot boss, and a long handle running out into the open space inside the bend —
 * the handle is the cue that reads "bender" at a glance. The head carries this bend's mark (arrow,
 * star or notch) and, when known, the bender's take-up. Returns { body, labels } so the caller draws
 * the metal behind the pipe and the text on top; '' when the first bend has no angle/heading.
 */
function benderParts(result, L, od, fmt = mmFmt) {
  const b0 = L.main.bends[0];
  if (!b0 || !b0.bendDeg || !Number.isFinite(b0.headingDeg)) return { body: '', labels: '' };
  const cx = L.X(b0.x), cy = L.Y(b0.y);
  const pw = L.pipeW;
  if (![cx, cy, pw].every(Number.isFinite)) return { body: '', labels: '' };
  // The two legs at the bend, as screen-space unit vectors pointing AWAY from the vertex (y flipped).
  const hin = (b0.headingDeg - b0.bendDeg / 2) * Math.PI / 180;   // incoming world heading
  const hout = (b0.headingDeg + b0.bendDeg / 2) * Math.PI / 180;  // outgoing world heading
  const legA = [-Math.cos(hin), Math.sin(hin)];                   // back along the incoming leg
  const legB = [Math.cos(hout), -Math.sin(hout)];                 // out along the outgoing leg
  let bx = legA[0] + legB[0], by = legA[1] + legB[1];             // bisector into the concave side
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl; by /= bl;                                             // unit "inside" direction: where the shoe sits
  const ang = Math.atan2(by, bx);                                // handle points this way
  // Size the shoe to the DRAWING, not just the pipe, so a zoomed-in small bend doesn't get a giant
  // tool. A compact wheel: a couple of pipe widths, capped to a fraction of the diagram.
  const diag = Math.hypot((L.maxX - L.minX) * L.s, (L.maxY - L.minY) * L.s) || pw * 10;
  const rs = Math.max(13, Math.min(pw * 2.0, diag * 0.12));
  const dC = rs * 0.92;                                          // centre offset: rim sits back near the vertex
  const Cx = cx + bx * dC, Cy = cy + by * dC;
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  // local frame: +x = handle direction (away from vertex), -x faces the pipe; y across.
  const S = (lx, ly) => [Cx + lx * cosA - ly * sinA, Cy + lx * sinA + ly * cosA];
  const P = (p) => `${n1(p[0])},${n1(p[1])}`;
  const polar = (phi, r) => S(r * Math.cos(phi * Math.PI / 180), r * Math.sin(phi * Math.PI / 180));
  const circ = (r, cls, extra = '') => `<circle class="${cls}" cx="${n1(Cx)}" cy="${n1(Cy)}" r="${n1(r)}"${extra}/>`;
  // handle: a long tapered bar from the head out along +x — the cue that reads "bender"
  const hx0 = rs * 0.55, hlen = rs * 3.3, w0 = rs * 0.46, w1 = rs * 0.28;
  const handle = `M${P(S(hx0, -w0 / 2))} L${P(S(hx0 + hlen, -w1 / 2))} A${n1(w1 / 2)},${n1(w1 / 2)} 0 0 1 ${P(S(hx0 + hlen, w1 / 2))} L${P(S(hx0, w0 / 2))} Z`;
  const grip = `M${P(S(hx0 + hlen * 0.46, -w1 / 2 - 0.5))} L${P(S(hx0 + hlen * 0.86, -w1 / 2 - 0.5))} L${P(S(hx0 + hlen * 0.86, w1 / 2 + 0.5))} L${P(S(hx0 + hlen * 0.46, w1 / 2 + 0.5))} Z`;
  // foot peg: the step, a small nub off the base toward the vertex side
  const foot = `M${P(polar(150, rs * 0.95))} L${P(polar(150, rs * 1.26))} L${P(polar(166, rs * 1.22))} L${P(polar(166, rs * 0.95))} Z`;
  const shadow = `<g filter="url(#bdSoft)" transform="translate(2.5,3.5)"><path class="bd-tool-shadow" d="${handle}"/><circle class="bd-tool-shadow" cx="${n1(Cx)}" cy="${n1(Cy)}" r="${n1(rs)}"/></g>`;
  const mark = benderMark(result.kind);
  // mark cast on the exposed top face of the wheel (phi -70), between the hub and the rim
  const mc = polar(-70, rs * 0.64);
  let glyph;
  if (mark.shape === 'star') {
    const o = rs * 0.26, inr = o * 0.42;
    const pts = Array.from({ length: 10 }, (_, j) => { const a = (j * Math.PI) / 5 - Math.PI / 2, r = j % 2 ? inr : o; return [mc[0] + r * Math.cos(a), mc[1] + r * Math.sin(a)]; });
    glyph = `<polygon class="bd-tool-mark" points="${pts.map(P).join(' ')}"/>`;
  } else if (mark.shape === 'notch') {
    glyph = `<path class="bd-tool-mark" d="M${P(polar(-70, rs * 0.98))} L${P(polar(-74, rs * 0.66))} L${P(polar(-66, rs * 0.66))} Z"/>`;
  } else {
    glyph = `<path class="bd-tool-mark" d="M${P(polar(-70, rs * 0.92))} L${P(polar(-76, rs * 0.58))} L${P(polar(-64, rs * 0.58))} Z"/>`;
  }
  // The shoe as a grooved wheel the pipe wraps: body disc, a dark channel ring near the rim between
  // two bright edges (the groove the conduit rides in), then a raised centre hub with the pivot.
  const body = `<g class="bd-tool">`
    + shadow
    + `<path class="bd-tool-handle" fill="url(#bdHandle)" d="${handle}"/>`
    + `<path class="bd-tool-grip" d="${grip}"/>`
    + `<path class="bd-tool-foot" fill="url(#bdShoe)" d="${foot}"/>`
    + circ(rs, 'bd-tool-shoe', ' fill="url(#bdHead)"')
    + circ(rs * 0.9, 'bd-tool-rim-edge', ' fill="none"')
    + circ(rs * 0.8, 'bd-tool-groove-bed', ` fill="none" stroke="url(#bdGroove)" stroke-width="${n1(rs * 0.16)}"`)
    + circ(rs * 0.72, 'bd-tool-rim-edge', ' fill="none"')
    + circ(rs * 0.5, 'bd-tool-hub', ' fill="url(#bdHead)"')
    + circ(rs * 0.17, 'bd-tool-hole', '')
    + glyph
    + '</g>';
  // labels upright in screen space so they read at any heading; over the hub, on top of the pipe
  const lab = (p, s, cls = 'bd-tool-label') => (Number.isFinite(p[0] + p[1]) ? text(p[0], p[1], s, cls, 'middle') : '');
  const takeUp = Number.isFinite(result.takeUpM) && result.takeUpM > 0 ? lab(S(0, rs * 0.52), `take-up ${fmt(result.takeUpM)}`) : '';
  const labels = `<g class="bd-tool-wrap">${lab(mc, mark.label)}${takeUp}</g>`;
  // extent of the drawn tool (wheel + handle tip), so the caller can grow the view to not clip it
  const tip1 = S(hx0 + hlen, w1 / 2 + 1), tip2 = S(hx0 + hlen, -w1 / 2 - 1);
  const xs = [Cx - rs, Cx + rs, tip1[0], tip2[0]], ys = [Cy - rs, Cy + rs, tip1[1], tip2[1]];
  const bbox = { minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) };
  return { body, labels, bbox };
}

/**
 * The bent pipe, side view, to scale.
 * opts: { fmt(m) -> string, width (px), odM, maxHeight }
 */
export function bentSvg(result, { fmt = mmFmt, width = 640, odM = 0, maxHeight = 340, tool = false } = {}) {
  const pipes = pipesFor(result);
  const od = odM || 0;
  const L = layoutFor(result, pipes, od, { width, maxHeight }, null);
  const t = tool ? benderParts(result, L, od, fmt) : { body: '', labels: '', bbox: null };
  const parts = [
    benderDefs(),
    ...backgroundParts(result, L, od),
    t.body,                         // the bender behind the pipe, so the bend is never buried
    ...pipePolys(pipes, L),
    ...breakParts(pipes, L),
    directionArrow(L),
    ...foregroundParts(result, L, od, fmt, pipes),
    t.labels,                       // tool text on top
  ];
  return svgWrap(width, L.height, 'Bent pipe with the bender in place, side view', parts.join(''), viewBoxWith(width, L.height, t.bbox));
}

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
export function animatedBendSvg(result, { fmt = mmFmt, width = 640, odM = 0, maxHeight = 340, reduced = false, still = null, frames = 26, durMs = 1500 } = {}) {
  const od = odM || 0;
  const defs = pipeSegsFor(result);
  const animate = !reduced && still == null;
  const finalPipes = defs.map((d) => ({ path: traceScaled(d.segs, d.start, 1), main: d.main, breaks: d.breaks }));
  if (!animate) {
    // a single frame: the finished shape (reduced) or a still at `still`
    const t = reduced ? 1 : Math.max(0, Math.min(1, still));
    const pipes = defs.map((d) => ({ path: traceScaled(d.segs, d.start, t), main: d.main, breaks: d.breaks }));
    const L = layoutFor(result, finalPipes, od, { width, maxHeight }, null);
    const parts = [
      benderDefs(),
      ...backgroundParts(result, L, od),
      ...pipePolys(pipes, L),
      ...breakParts(finalPipes, L),
      directionArrow(L),
      ...foregroundParts(result, L, od, fmt, finalPipes),
    ];
    return svgWrap(width, L.height, 'Bent pipe, side view, to scale', parts.join(''));
  }

  const N = Math.max(2, frames);
  const framePipes = Array.from({ length: N }, (_, i) => {
    const t = easeInOut(i / (N - 1));
    return defs.map((d) => traceScaled(d.segs, d.start, t));
  });
  // the view must contain every frame, so the pipe forms in place without the frame jumping
  const bboxPts = framePipes.flat().flatMap((p) => p.points).concat(finalPipes.flatMap((p) => p.path.points));
  const L = layoutFor(result, finalPipes, od, { width, maxHeight }, bboxPts);
  const dur = `${(durMs / 1000).toFixed(2)}s`;

  const parts = [benderDefs(), ...backgroundParts(result, L, od)];
  defs.forEach((d, pi) => {
    const finalPts = finalPipes[pi].path.points;
    const count = finalPts.length;
    const hasArc = d.segs.some((s) => s.bendDeg != null && s.radiusM);
    // one value per frame; the last is the true finished shape, so the frozen end matches the rest
    const frameVals = framePipes.map((fp, i) => {
      const raw = i === N - 1 ? finalPts : fp[pi].points;
      const pts = hasArc ? resample(raw, count) : raw;
      return pts.map((p) => L.P(p)).map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ');
    });
    const base = frameVals[frameVals.length - 1];
    const values = frameVals.join(';');
    for (const [cls, w] of pipeLayers(L.pipeW)) {
      parts.push(`<polyline class="${cls}" stroke-width="${n1(w)}" points="${base}"><animate class="bd-anim" attributeName="points" dur="${dur}" begin="indefinite" fill="freeze" calcMode="linear" values="${values}"/></polyline>`);
    }
  });
  parts.push(...breakParts(finalPipes, L));
  parts.push(directionArrow(L));
  // the dimensions and labels appear as the shape settles (base opacity 1, no script needed)
  const fg = foregroundParts(result, L, od, fmt, finalPipes).join('');
  parts.push(`<g class="bd-reveal" opacity="1"><animate class="bd-anim" attributeName="opacity" dur="${dur}" begin="indefinite" fill="freeze" calcMode="linear" keyTimes="0;0.55;1" values="0;0;1"/>${fg}</g>`);
  return svgWrap(width, L.height, 'Bend forming, side view', parts.join(''));
}

// ---------------------------------------------------------------------------

const SYMBOLS = {
  arrow: (x, y) => `<path class="bd-sym" d="M${n1(x - 6)},${n1(y - 10)} L${n1(x + 6)},${n1(y - 10)} L${n1(x)},${n1(y)} Z"/>`,
  star: (x, y) => {
    const pts = [];
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 3.2 : 7.5, a = (Math.PI / 5) * k - Math.PI / 2;
      pts.push(`${n1(x + r * Math.cos(a))},${n1(y - 7 + r * Math.sin(a))}`);
    }
    return `<polygon class="bd-sym" points="${pts.join(' ')}"/>`;
  },
  notch: (x, y) => `<path class="bd-sym" d="M${n1(x)},${n1(y - 14)} L${n1(x + 6)},${n1(y - 7)} L${n1(x)},${n1(y)} L${n1(x - 6)},${n1(y - 7)} Z"/>`,
  heat: (x, y) => `<path class="bd-sym heat" d="M${n1(x)},${n1(y)} C${n1(x - 7)},${n1(y - 6)} ${n1(x - 2)},${n1(y - 10)} ${n1(x)},${n1(y - 15)} C${n1(x + 2)},${n1(y - 10)} ${n1(x + 7)},${n1(y - 6)} ${n1(x)},${n1(y)} Z"/>`,
  tick: () => '',
};
export const SYMBOL_NAMES = { arrow: 'arrow', star: 'star (back of 90)', notch: 'centre-of-bend mark', heat: 'heat', tick: 'reference' };

const shortTag = (m) => {
  const n = /(\d+)$/.exec(m.label);
  if (n) return n[1];
  if (/start/i.test(m.label)) return 'start';
  if (/end/i.test(m.label)) return 'end';
  return '';
};

/**
 * A small upright hand bender for the mark layout — a grey cast head with a hook beak and a socket,
 * and a blue handle — drawn under a mark so you can see where to set the bender and which way it
 * faces, the way field bending apps do. The head is built hook-on-the-left around a centred handle;
 * `flip` mirrors it (hook to the right) for a bend made the other way (mark.dir === 'down'). x is the
 * mark's x; yTop is the top of the head. Pure string; all values finite.
 */
export function benderGlyph(x, yTop, flip = false) {
  // Side profile of a conduit hand bender: a thick cast hook whose open mouth (top) cups the pipe,
  // a lip that curls over to catch it, a socket boss, and a long blue handle. Built from two
  // concentric arcs so it reads as a real sickle-shaped shoe, not a blob. `flip` mirrors it.
  // Solid cast head: a hook lip rises on the left, the pipe nestles in the concave cradle on top,
  // and the body bulges down to the handle socket. The pipe sits at ~y=-2 (just above the origin).
  const head = '<path class="bd-bender-head" d="'
    + 'M-13,-4 '                 // left lip tip
    + 'Q-13,-9 -8,-8 '           // lip curls up over the pipe end (the hook)
    + 'Q-4,-7 -2,-3 '            // down the inner face of the lip
    + 'Q1,0 4,-3 '              // the cradle: a dip the pipe rests in, up to the right rim
    + 'Q7,-6 10,-4 '            // right rim
    + 'C14,-1 14,8 8,13 '       // right side bulges down to the handle
    + 'C4,16 -2,16 -6,13 '      // bottom
    + 'C-11,10 -15,2 -13,-4 Z"/>';
  const cradle = '<path class="bd-bender-cradle" d="M-2,-3 Q1,0.5 4,-3"/>'; // groove highlight
  const socket = '<circle class="bd-bender-socket" cx="1" cy="13" r="3.4"/>';
  const bolt = '<circle class="bd-bender-bolt" cx="1" cy="13" r="1.3"/>';
  const handle = '<rect class="bd-bender-handle" x="-1.5" y="15" width="5" height="34" rx="2.5"/>';
  const grip = '<rect class="bd-bender-grip" x="-1.5" y="17" width="5" height="9" rx="2.5"/>';
  const t = flip ? `translate(${n1(x)},${n1(yTop)}) scale(-1,1)` : `translate(${n1(x)},${n1(yTop)})`;
  return `<g class="bd-bender" transform="${t}">${head}${cradle}${socket}${bolt}${handle}${grip}</g>`;
}

/**
 * The straight pipe with its marks, measured from the reference end.
 * opts: { fmt(m), snap(m) (round to what a tape reads), width }
 */
export function marksSvg(result, { fmt = mmFmt, snap = (m) => m, width = 640 } = {}) {
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
  const L = 22, R = 22;
  const k = (width - L - R) / xMax;
  const X = (atM) => L + (atM - shift) * k;
  const pipeH = 16;
  const parts = [];
  let y = 8;
  for (const row of rows) {
    const marks = [...row.marks].sort((a, b) => a.atM - b.atM);
    const dense = marks.length > 6;
    if (row.title) { parts.push(text(L, y + 12, row.title, 'bd-rowtitle', 'start')); y += 18; }
    // labels above: number, angle and note; stagger when crowded
    const topY = y + 62;
    let lastX = [-1e9, -1e9];
    const above = [];
    marks.forEach((m) => {
      const x = X(m.atM);
      const level = x - lastX[0] >= 54 ? 0 : x - lastX[1] >= 54 ? 1 : 0;
      lastX[level] = x;
      above.push({ m, x, level });
    });
    const pipeY = topY + 10;
    // pipe body as a shaded bar (dark edge, mid body, light highlight band) to match the hero tube
    const barW = n1(X(last) + tail * k - L);
    parts.push(`<rect class="bd-pipebar-edge" x="${L}" y="${pipeY}" width="${barW}" height="${pipeH}" rx="3"/>`);
    parts.push(`<rect class="bd-pipebar-body" x="${L}" y="${n1(pipeY + 1.5)}" width="${barW}" height="${n1(pipeH - 3)}" rx="2"/>`);
    parts.push(`<rect class="bd-pipebar-hi" x="${L}" y="${n1(pipeY + 2)}" width="${barW}" height="${n1(Math.max(2, pipeH * 0.28))}" rx="2"/>`);
    const startM = marks.find((m) => /^(Start of|Pipe \d+ start)/.test(m.label));
    const endM = marks.find((m) => /(End of|end of bend)/.test(m.label));
    if (endM) {
      const s = startM ? startM.atM : result.startM ?? endM.atM;
      parts.push(`<rect class="${marks.some((m) => m.symbol === 'heat') ? 'bd-heatzone' : 'bd-bendzone'}" x="${n1(X(s))}" y="${pipeY}" width="${n1(Math.max(1, X(endM.atM) - X(s)))}" height="${pipeH}"/>`);
    }
    // the reference end
    if (!fromMark1) {
      parts.push(line(L, pipeY - 6, L, pipeY + pipeH + 6, 'bd-endcap'));
      parts.push(text(L, pipeY + pipeH + 30, 'END', 'bd-endtext', 'start'));
    } else parts.push(breakMark(L + 0.07 * spread * k, pipeY + pipeH / 2, 0, pipeH));
    if (compress) parts.push(breakMark(L + (shift > 0 ? 0.22 * spread * k : 0), pipeY + pipeH / 2, 0, pipeH));
    for (const { m, x, level } of above) {
      const ly = topY - level * 30;
      parts.push(line(x, pipeY - 2, x, pipeY + pipeH + 2, m.symbol === 'tick' ? 'bd-tick' : 'bd-markline'));
      parts.push(SYMBOLS[m.symbol || 'arrow'](x, pipeY - 2));
      const angle = m.angleDeg ? fmtDeg(m.angleDeg) : '';
      if (!dense || m.symbol === 'tick' || m === marks.find((q) => q.angleDeg)) {
        parts.push(text(x, ly - 18, [shortTag(m), angle].filter(Boolean).join(' · '), 'bd-marktag'));
        if (m.note && !dense) parts.push(text(x, ly - 5, m.note, 'bd-note'));
      }
    }
    // positions from the end, below the pipe
    let lastPx = [-1e9, -1e9];
    const posY = pipeY + pipeH + 16;
    marks.forEach((m, i) => {
      if (dense && !(i === 0 || i === marks.length - 1 || m.symbol === 'tick' || i === 1)) return;
      const x = X(m.atM);
      const level = x - lastPx[0] >= 64 ? 0 : 1;
      lastPx[level] = x;
      parts.push(text(x, posY + level * 14, fmt(snap(m.atM)), 'bd-pos'));
    });
    // chain dimensions between marks
    const chainY = posY + 40;
    if (!dense) {
      const pts = [compress || fromMark1 ? null : 0, ...marks.map((m) => m.atM)].filter((v) => v != null);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const d = snap(b) - snap(a);
        if (d <= 0) continue;
        const xa = X(a), xb = X(b);
        parts.push(line(xa, chainY, xb, chainY, 'bd-dim-span'), line(xa, chainY - 4, xa, chainY + 4, 'bd-dim-span'), line(xb, chainY - 4, xb, chainY + 4, 'bd-dim-span'));
        if (xb - xa > 34) parts.push(text((xa + xb) / 2, chainY - 5, fmt(d), 'bd-spantext'));
      }
      // a bender under each real bend mark — "set the bender here", like a field bending app
      const benderMarks = marks.filter((m) => ['arrow', 'star', 'notch'].includes(m.symbol) && m.angleDeg);
      const bandTop = chainY + 20;
      // the bender faces the way the bend is made: 'down' bends mirror the head (hook to the right)
      for (const m of benderMarks) parts.push(benderGlyph(X(m.atM), bandTop, m.dir === 'down'));
      y = benderMarks.length ? bandTop + 54 : chainY + 14;
    } else {
      const shots = marks.filter((m) => m.angleDeg);
      if (shots.length > 1) parts.push(text(X(shots[0].atM), chainY - 4, `${shots.length} marks, every ${fmt(shots[1].atM - shots[0].atM)}`, 'bd-dimtext', 'start'));
      y = chainY + 6;
    }
    y += 10;
  }
  const h = Math.round(y);
  return `<svg class="bend-svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-label="Straight pipe with the bend marks" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

/** End view of a rolling offset: rise, roll and the true offset. */
export function rollSvg(result, { fmt = mmFmt, size = 200 } = {}) {
  const { riseM, rollM, trueM, rollDeg } = result.endView;
  const m = Math.max(riseM, rollM, 0.001);
  const s = (size - 70) / m;
  const x0 = 40, y0 = size - 30;
  const x1 = x0 + rollM * s, y1 = y0 - riseM * s;
  const up = Math.min(size - 50, Math.max(riseM * s, 60));
  const r = 34, a = (rollDeg * Math.PI) / 180;
  const parts = [
    `<line class="bd-tick" x1="${x0}" y1="${y0}" x2="${x0}" y2="${n1(y0 - up)}"/>`,
    text(x0, y0 - up - 6, 'up', 'bd-note'),
    `<path class="bd-dim" fill="none" d="M${x0},${y0 - r} A${r},${r} 0 0 1 ${n1(x0 + r * Math.sin(a))},${n1(y0 - r * Math.cos(a))}"/>`,
    line(x0, y0, x1, y0, 'bd-dim'), line(x1, y0, x1, y1, 'bd-dim'),
    line(x0, y0, x1, y1, 'bd-true'),
    `<circle class="bd-end" cx="${x0}" cy="${y0}" r="5"/>`, `<circle class="bd-end" cx="${n1(x1)}" cy="${n1(y1)}" r="5"/>`,
    text((x0 + x1) / 2, y0 + 18, `roll ${fmt(rollM)}`, 'bd-dimtext'),
    text(x1 + 6, (y0 + y1) / 2, `rise ${fmt(riseM)}`, 'bd-dimtext', 'start'),
    text((x0 + x1) / 2 + 10, (y0 + y1) / 2 - 8, `true ${fmt(trueM)}`, 'bd-angle', 'end'),
    text(x0 + r * Math.sin(a / 2) + 6, y0 - r * Math.cos(a / 2) - 6, `${fmtDeg(rollDeg)} from up`, 'bd-note', 'start'),
  ];
  return `<svg class="bend-svg roll" viewBox="0 0 ${size + 60} ${size}" width="${size + 60}" height="${size}" role="img" aria-label="End view of the rolling offset" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

export { FONT };
