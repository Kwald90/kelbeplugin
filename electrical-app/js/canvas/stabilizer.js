// Stroke stabilizer: takes the hand's jitter out of freehand ink. Pure (no DOM), so it can be
// tested. One knob, smoothness 0–100, that gets steadily stronger along the whole slider:
//   0       raw: exactly what ink.js's addInkPoint/endInk would keep (no filtering at all)
//   1–99    a pulled string (lazy brush): the ink follows the tip on a string and only moves once
//           the string is taut, so wobble shorter than the string never reaches the paper. A short
//           easing after it rounds off what is left. Both lengths grow along a curve with the
//           setting, so each step of the slider smooths visibly more than the one before.
//   81–99   plus a pull toward the straight line from where the stroke began to the pen, rising
//           to all the way at...
//   100     a ruler: the stroke is the straight line from the first point to the pen, live while
//           drawing, and committed as two points.
// Every length is in screen px (CSS px, which are the same physical size at any devicePixelRatio)
// and divided by the zoom, so a setting feels the same at any zoom on any screen. Nothing depends
// on time or on how often the device samples the pen (60 Hz Safari, 240 Hz Pencil with coalesced
// events), only on how far the pen moved.
// Sharp corners (the tip of a V, the apex of an A) are found on the raw samples and drawn exactly
// where the pen turned: the string is let go there, so smoothing never rounds them off. On pen-up
// the ink catches up to where the pen lifted.
import { addInkPoint, endInk, turnAngle, CORNER_MIN_LEN } from './ink.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Clamp anything to a whole smoothness 0–100. */
export const clampSmooth = (s) => clamp(Math.round(Number(s) || 0), 0, 100);

/**
 * The smoothness scale saved settings are on. Scale 1 (before) was a One Euro filter that barely
 * changed from 40 to 99 and was never straight at 100; 55 on it smooths about as much as 30 now.
 */
export const SMOOTH_SCALE = 2;
/** A smoothness saved on scale 1 as the same feel on this scale; 100 (asking for straight) stays 100. */
export const fromOldSmooth = (s) => { const v = clampSmooth(s); return v >= 100 ? 100 : Math.round(v * 0.55); };

/** Longest string (screen px), at 99%. */
export const STRING_MAX = 42;
/** Longest easing distance after the string (screen px). */
export const EASE_MAX = 9;
/** Above this, the stroke is pulled toward its straight chord (all the way at 100). */
export const CHORD_FROM = 80;

/**
 * Filter settings for a smoothness 0–100, or null for raw. Lengths are screen px.
 *   string    how far the tip pulls before the ink follows
 *   ease      distance constant of the easing after the string
 *   chord     0–1, how far every point is pulled onto the line start -> pen (1: a straight line)
 *   straight  true at 100: the stroke is exactly that line, two points
 */
export function smoothParams(smoothness) {
  const s = clampSmooth(smoothness);
  if (!s) return null;
  const k = s / 100;
  return {
    straight: s === 100,
    string: STRING_MAX * k ** 1.6,      // 1.1 px at 10, 4 at 25, 14 at 50, 26 at 75, 41 at 99
    ease: EASE_MAX * k ** 1.2,
    chord: s <= CHORD_FROM ? 0 : ((s - CHORD_FROM) / (100 - CHORD_FROM)) ** 2,
    cornerLen: 12 + 10 * k,             // px measured either side of a corner (longer than a hand's tremor)
    cornerDeg: 60,                      // a turn at least this sharp is a corner...
    sharpness: 0.7,                     // ...if it is nearly as sharp measured over half the length (a curve is not)
  };
}

/**
 * A stabilizer for one stroke. Feed it every pen sample in world units with add(); its `points`
 * are the stroke's points (the same array the whole time, rewritten in place when a corner is
 * found a few samples late, or every sample while the stroke is being pulled straight). Call
 * end() on pen-up.
 * @param {{ smoothness?: number, zoom?: number, minDist?: number, pressureEase?: number }} opts
 *   zoom: screen px per world unit (filter lengths are in screen px); minDist: as addInkPoint.
 */
export function createStabilizer({ smoothness = 0, zoom = 1, minDist = 0, pressureEase = 0.6 } = {}) {
  const prm = smoothParams(smoothness);
  const out = [];
  const ink = { minDist, pressureEase };
  let lastSample = null;

  if (!prm) {
    // raw: the same as collecting with addInkPoint and finishing with endInk
    return {
      points: out, smoothness: 0, corners: [],
      add(sample) { lastSample = sample; addInkPoint(out, sample, ink); },
      end(sample = lastSample) { return endInk(out, sample); },
    };
  }

  if (prm.straight) {
    // a ruler from the first point to the pen
    return {
      points: out, smoothness: 100, corners: [],
      add(sample) {
        lastSample = sample;
        const p = sample[2] ?? 0.5;
        if (!out.length) { out.push([sample[0], sample[1], p]); return; }
        const prev = out[out.length - 1][2];
        out[1] = [sample[0], sample[1], prev * (1 - pressureEase) + p * pressureEase];
      },
      end(sample = lastSample) {
        if (sample && out.length) this.add(sample);
        return out;
      },
    };
  }

  const string = prm.string / zoom, ease = prm.ease / zoom;
  const base = prm.chord ? [] : out; // the smoothed points; `out` is them pulled toward the chord
  const raw = [];        // every sample: { x, y, p }
  const outRaw = [];     // for each base point, the raw sample it came from
  const corners = [];    // raw indices kept as corners
  let brush = null;      // the end of the string
  let f = null;          // the eased point that is drawn
  let cornerAt = -1;     // base index of the newest corner
  let anchor = 0;        // raw index the corner search starts from (the last corner)
  let evalNext = 1;      // next raw index to test as a corner
  let run = null;        // a run of corner-sharp candidates: { j0, j1, a, c }
  const L = prm.cornerLen / zoom;
  const cornerGap = CORNER_MIN_LEN + 0.01; // ink.js draws a corner only with this much either side

  function emit(x, y, p, i) {
    const md = cornerAt === base.length - 1 ? Math.max(minDist, cornerGap) : minDist;
    if (addInkPoint(base, [x, y, p], { minDist: md, pressureEase })) outRaw.push(i);
  }

  /** Pull the string toward (x, y), ease the drawn point after it, and emit that point. */
  function step(x, y, p, i, len = string) {
    const dx = x - brush.x, dy = y - brush.y, d = Math.hypot(dx, dy);
    if (d <= len) return;
    const bx = brush.x + (dx * (d - len)) / d, by = brush.y + (dy * (d - len)) / d;
    const moved = Math.hypot(bx - brush.x, by - brush.y);
    brush.x = bx; brush.y = by;
    // easing by distance travelled, not by time: the same at any sample rate
    const a = ease > 0 ? 1 - Math.exp(-moved / ease) : 1;
    f.x += a * (brush.x - f.x); f.y += a * (brush.y - f.y);
    emit(f.x, f.y, p, i);
  }

  function process(i) {
    const r = raw[i];
    if (!brush) {
      brush = { x: r.x, y: r.y };
      f = { x: r.x, y: r.y };
      emit(r.x, r.y, r.p, i);
      return;
    }
    step(r.x, r.y, r.p, i);
  }

  /** With a chord pull: every smoothed point moved part of the way onto the line start -> pen. */
  function pullToChord() {
    if (base === out) return;
    const w = prm.chord;
    const A = base[0], P = raw[raw.length - 1];
    out.length = 0;
    if (!A) return;
    const ux = P.x - A[0], uy = P.y - A[1], uu = ux * ux + uy * uy;
    for (const q of base) {
      let px = A[0], py = A[1];
      if (uu > 0) { const t = ((q[0] - A[0]) * ux + (q[1] - A[1]) * uy) / uu; px = A[0] + t * ux; py = A[1] + t * uy; }
      out.push([q[0] + w * (px - q[0]), q[1] + w * (py - q[1]), q[2]]);
    }
  }

  // ---- corners, found on the raw samples ----
  const farBack = (j, len) => { for (let k = j - 1; k >= anchor; k--) if (dist(raw[k], raw[j]) >= len) return k; return -1; };
  const farAhead = (j, len) => { for (let k = j + 1; k < raw.length; k++) if (dist(raw[k], raw[j]) >= len) return k; return -1; };

  function closeRun() {
    if (!run) return;
    // the corner is the sample farthest from the line joining the two arms
    const A = raw[run.a], C = raw[run.c];
    const ux = C.x - A.x, uy = C.y - A.y, ul = Math.hypot(ux, uy) || 1;
    let best = run.j0, bd = -1;
    for (let j = run.j0; j <= run.j1; j++) {
      const dd = Math.abs((raw[j].x - A.x) * uy - (raw[j].y - A.y) * ux) / ul;
      if (dd > bd) { bd = dd; best = j; }
    }
    run = null;
    applyCorner(best);
  }

  function findCorners() {
    while (evalNext < raw.length - 1) {
      const j = evalNext;
      const c = farAhead(j, L);
      if (c < 0) return; // not far enough past it yet
      evalNext++;
      // a candidate a corner-length past the run is another corner (a zig-zag): settle the first
      if (run && dist(raw[j], raw[run.j1]) >= L) closeRun();
      if (j <= anchor) continue;
      const a = farBack(j, L);
      if (a < 0) { closeRun(); continue; }
      const ang = turnAngle([raw[a].x, raw[a].y], [raw[j].x, raw[j].y], [raw[c].x, raw[c].y]);
      let sharp = ang >= prm.cornerDeg;
      if (sharp) {
        const a2 = farBack(j, L / 2), c2 = farAhead(j, L / 2);
        const ang2 = turnAngle([raw[a2].x, raw[a2].y], [raw[j].x, raw[j].y], [raw[c2].x, raw[c2].y]);
        sharp = ang2 >= ang * prm.sharpness;
      }
      if (sharp) {
        if (run) { run.j1 = j; run.c = c; } else run = { j0: j, j1: j, a, c };
      } else closeRun();
    }
  }

  /** Keep raw sample j exactly as a corner: rewind the ink to before it, let go of the string there, replay. */
  function applyCorner(j) {
    const tip = raw[j];
    let k = base.length;
    while (k > 1 && outRaw[k - 1] >= j) k--;
    base.length = k; outRaw.length = k;
    while (base.length > 1 && Math.hypot(base[base.length - 1][0] - tip.x, base[base.length - 1][1] - tip.y) < cornerGap) { base.pop(); outRaw.pop(); }
    const prev = base[base.length - 1];
    if (prev && prev[0] === tip.x && prev[1] === tip.y) { base.pop(); outRaw.pop(); }
    base.push([tip.x, tip.y, prev ? prev[2] * (1 - pressureEase) + tip.p * pressureEase : tip.p]);
    outRaw.push(j);
    cornerAt = base.length - 1;
    corners.push(j);
    brush = { x: tip.x, y: tip.y };
    f = { x: tip.x, y: tip.y };
    anchor = j;
    evalNext = Math.max(evalNext, j + 1);
    for (let i = j + 1; i < raw.length; i++) process(i);
  }

  return {
    points: out, smoothness: clampSmooth(smoothness), corners,
    /** One sample [x, y, pressure] in world units. (A timestamp may be passed; it is not needed.) */
    add(sample) {
      raw.push({ x: sample[0], y: sample[1], p: sample[2] ?? 0.5 });
      lastSample = sample;
      process(raw.length - 1);
      findCorners();
      pullToChord();
    },
    /** Pen-up: settle any corner, glide the ink onto the last sample and end exactly there. */
    end(sample = lastSample) {
      if (!raw.length) return out;
      if (sample && (sample[0] !== raw[raw.length - 1].x || sample[1] !== raw[raw.length - 1].y)) this.add(sample);
      closeRun();
      const r = raw[raw.length - 1];
      const i = raw.length - 1;
      // a few virtual steps with the string shortening to nothing, so the end is a curve, not a hook
      const N = 8;
      for (let n = 1; n <= N; n++) step(r.x, r.y, r.p, i, string * (1 - n / N));
      endInk(base, [r.x, r.y, r.p]);
      pullToChord();
      return out;
    },
  };
}
