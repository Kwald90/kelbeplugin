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
const poly = (pts, cls, w) => `<polyline class="${cls}" points="${pts.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ')}"${w ? ` style="stroke-width:${n1(w)}px"` : ''}/>`;

/** A dimension line with end ticks and a label in the middle. */
function dim(x1, y1, x2, y2, label, side = 'right') {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
  const t = 5;
  const ticks = vertical
    ? line(x1 - t, y1, x1 + t, y1, 'bd-dim') + line(x2 - t, y2, x2 + t, y2, 'bd-dim')
    : line(x1, y1 - t, x1, y1 + t, 'bd-dim') + line(x2, y2 - t, x2, y2 + t, 'bd-dim');
  const lab = vertical
    ? (side === 'left' ? text(mx - 8, my + 4, label, 'bd-dimtext', 'end') : text(mx + 8, my + 4, label, 'bd-dimtext', 'start'))
    : text(mx, my - 6, label, 'bd-dimtext');
  return line(x1, y1, x2, y2, 'bd-dim') + ticks + lab;
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
  if (startHeading === 0 && segs[0].straightM > 1.4 * span) { segs[0].straightM = 0.7 * span; breaks.push('first'); }
  if (segs[last].straightM > 1.4 * span) { segs[last].straightM = 0.7 * span; breaks.push('last'); }
  return { segs, breaks };
}

/** The pipes to draw for a result, in metres: [{ path, od, main }]. */
function pipesFor(result, odM) {
  const out = [];
  const startH = result.start?.headingDeg ?? 0;
  if (result.kind === 'concentric') {
    const leg = result.topM ? Math.max(0.02, result.topM - result.innerRadiusM) : result.innerRadiusM * 0.5;
    for (const p of result.pipes) {
      const lead = Math.min(result.startM, Math.max(result.innerRadiusM * 0.4, 0.05));
      const path = tracePath([{ straightM: lead }, { bendDeg: 90, radiusM: p.radiusM }, { straightM: leg }], { x: 0, y: -(p.index - 1) * result.centersM });
      out.push({ path, main: p.index === 1, breaks: lead < result.startM ? ['first'] : [] });
    }
    return out;
  }
  if (result.kind === 'parallel') {
    const cap = capSegments(result.segments, 0, result.reference === 'mark1');
    const cut = result.segments[0].straightM - cap.segs[0].straightM; // negative when a lead-in was added
    for (const p of result.pipes) {
      const [a, b] = p.marks;
      const segs = [{ straightM: a.atM - cut }, { bendDeg: result.angleDeg }, { straightM: b.atM - a.atM }, { bendDeg: -result.angleDeg }, { straightM: cap.segs[cap.segs.length - 1].straightM }];
      out.push({ path: tracePath(segs, { x: 0, y: -(p.index - 1) * result.centersM }), main: p.index === 1, breaks: cap.breaks });
    }
    return out;
  }
  const cap = capSegments(result.segments, startH, result.reference === 'mark1');
  out.push({ path: tracePath(cap.segs, result.start), main: true, breaks: cap.breaks });
  return out;
}

/**
 * The bent pipe, side view, to scale.
 * opts: { fmt(m) -> string, width (px), odM, maxHeight }
 */
export function bentSvg(result, { fmt = mmFmt, width = 640, odM = 0, maxHeight = 340 } = {}) {
  const pipes = pipesFor(result, odM);
  const od = odM || 0;
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
  // bounding box with room for dimension lines
  let minX = Math.min(...all.map((p) => p[0])) - od / 2, maxX = Math.max(...all.map((p) => p[0])) + od / 2;
  let minY = lowest - od / 2, maxY = Math.max(...all.map((p) => p[1])) + od / 2;
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
  const pipeW = Math.max(4, od * s);
  const parts = [];

  // the surface the pipe lies on, and the obstruction
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

  // pipes: an outline stroke and a lighter core, so it reads as tube
  for (const p of pipes) {
    const pts = p.path.points.map(P);
    parts.push(poly(pts, 'bd-pipe', pipeW + 2), poly(pts, 'bd-pipe-core', Math.max(1.5, pipeW - 3)));
    if (p.breaks.includes('first') && pts.length > 1) {
      const [a, b] = [pts[0], pts[1]];
      parts.push(breakMark((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, pipeW));
    }
    if (p.breaks.includes('last') && pts.length > 1) {
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
      parts.push(breakMark((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, pipeW));
    }
  }

  // the reference end
  const [ex, ey] = P(main.points[0]);
  if (result.reference !== 'mark1') {
    parts.push(`<circle class="bd-end" cx="${n1(ex)}" cy="${n1(ey)}" r="${n1(Math.min(7, Math.max(3, pipeW / 2)))}"/>`);
    parts.push(text(ex, ey - pipeW / 2 - 8, 'END', 'bd-endtext'));
  }

  // bend labels: mark number and angle, outside each bend
  const bendMarks = result.marks.filter((m) => m.angleDeg && (!m.pipe || m.pipe === 1));
  if (result.kind === 'concentric') {
    parts.push(text(PAD, PAD - 10, `90° in ${result.shots} shot${result.shots === 1 ? '' : 's'} each`, 'bd-angle', 'start'));
  } else if (result.kind === 'segment') {
    const mid = main.bends[Math.floor(main.bends.length / 2)];
    if (mid) parts.push(text(X(mid.x) + 14, Y(mid.y) + 14, `${fmtDeg(result.angleDeg ?? 90)} in ${result.shots} shots`, 'bd-angle', 'start'));
  } else {
    main.bends.forEach((b, i) => {
      const m = bendMarks[i];
      const h = (b.headingDeg * Math.PI) / 180;
      const sign = Math.sign(b.bendDeg) || 1;
      // outside of the bend, in screen space (y flips)
      const ox = Math.sin(h) * sign, oy = Math.cos(h) * sign;
      const d = pipeW / 2 + 16 + (result.kind === 'parallel' && b.bendDeg > 0 ? (result.count - 1) * result.centersM * s : 0);
      const x = X(b.x) + ox * d, y = Y(b.y) + oy * d + 4;
      const label = [m ? shortTag(m) : '', fmtDeg(Math.abs(b.bendDeg))].filter(Boolean).join(' · ');
      parts.push(text(x, y, label, 'bd-angle'));
    });
  }

  // dimensions
  const gap = pipeW / 2 + 14;
  for (const d of dims) {
    if (d.type === 'rise' && main.bends.length >= 2) {
      const yA = main.points[0][1], yB = main.bends[1].y;
      const x = X(maxX) + 12;
      parts.push(dim(x, Y(yA), x, Y(yB), fmt(d.label)));
    } else if (d.type === 'kick' && main.bends.length) {
      const x = X(minX) - 14;
      parts.push(dim(x, Y(0), x, Y(main.bends[0].y), fmt(d.label), 'left'));
    } else if (d.type === 'stub') {
      const x = X(minX) - 14;
      parts.push(dim(x, Y(0), x, Y(lowest - od / 2), fmt(d.label), 'left'));
    } else if (d.type === 'leg' || d.type === 'backToBack') {
      const y = Y(lowest - od / 2) + gap;
      parts.push(dim(X(-od / 2), y, X(main.end[0] + (d.type === 'backToBack' ? od / 2 : 0)), y, fmt(d.label)));
    } else if (d.type === 'obstacle') {
      const label = d.round ? `${fmt(d.heightM)} obstruction` : `${fmt(d.heightM)} × ${fmt(d.widthM)}`;
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
  const h = Math.round(height);
  return `<svg class="bend-svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-label="Bent pipe, side view" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
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
    // pipe body, shaded where heat goes or a bend is
    parts.push(`<rect class="bd-straight" x="${L}" y="${pipeY}" width="${n1(X(last) + tail * k - L)}" height="${pipeH}" rx="3"/>`);
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
        parts.push(line(xa, chainY, xb, chainY, 'bd-dim'), line(xa, chainY - 4, xa, chainY + 4, 'bd-dim'), line(xb, chainY - 4, xb, chainY + 4, 'bd-dim'));
        if (xb - xa > 34) parts.push(text((xa + xb) / 2, chainY - 5, fmt(d), 'bd-dimtext'));
      }
      y = chainY + 14;
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
