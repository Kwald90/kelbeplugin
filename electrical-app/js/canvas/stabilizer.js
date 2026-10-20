// Stroke stabilizer: takes the hand's jitter out of freehand ink. Pure (no DOM), so it can be
// tested. One knob, smoothness 0–100:
//   0       raw: exactly what ink.js's addInkPoint/endInk would keep (no filtering at all)
//   1–100   a One Euro filter (Casiez et al.): a low-pass whose cutoff rises with speed, so slow
//           shaky writing is smoothed hard while a quick stroke barely lags; stronger with the setting
//   > 40    plus a "lazy brush" (string pull): the ink only follows once the tip has pulled a short
//           string taut, which irons out wobble in long slow lines
// Sharp corners (the tip of a V, the apex of an A) are found on the raw samples and drawn exactly
// where the pen turned: the filter restarts there, so smoothing never rounds them off. On pen-up
// the ink catches up to where the pen lifted.
import { addInkPoint, endInk, turnAngle, CORNER_MIN_LEN } from './ink.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Clamp anything to a whole smoothness 0–100. */
export const clampSmooth = (s) => clamp(Math.round(Number(s) || 0), 0, 100);

/**
 * Filter settings for a smoothness 0–100, or null for raw. Lengths are screen px, so a setting
 * feels the same at any zoom.
 */
export function smoothParams(smoothness) {
  const s = clampSmooth(smoothness);
  if (!s) return null;
  const k = s / 100;
  return {
    minCutoff: 12 * 0.04 ** k,          // Hz while still: 11.6 at 1, 2.4 at 50, 0.48 at 100
    beta: 0.03 * (1 - 0.8 * k),         // how fast the cutoff opens with speed (per px/s)
    dCutoff: 1,                         // Hz, for the speed estimate
    lazy: s <= 40 ? 0 : ((s - 40) / 60) ** 1.3 * 16, // string length, px: 1.6 at 50, 16 at 100
    cornerLen: 6 + 6 * k,               // px measured either side of a corner
    cornerDeg: 60,                      // a turn at least this sharp is a corner...
    sharpness: 0.7,                     // ...if it is nearly as sharp measured over half the length (a curve is not)
  };
}

const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

/**
 * A stabilizer for one stroke. Feed it every pen sample in world units with add(); its `points`
 * are the stroke's points (the same array the whole time, rewritten in place when a corner is
 * found a few samples late). Call end() on pen-up.
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

  const raw = [];        // every sample: { x, y, p, t }
  const outRaw = [];     // for each out point, the raw sample it came from
  const corners = [];    // raw indices kept as corners
  let f = null;          // filter state { x, y, vx, vy, t }
  let brush = null;      // lazy brush position
  let cornerAt = -1;     // out index of the newest corner
  let anchor = 0;        // raw index the corner search starts from (the last corner)
  let evalNext = 1;      // next raw index to test as a corner
  let run = null;        // a run of corner-sharp candidates: { j0, j1, a, c }
  const L = prm.cornerLen / zoom;
  const cornerGap = CORNER_MIN_LEN + 0.01; // ink.js draws a corner only with this much either side

  function emit(x, y, p, i) {
    const md = cornerAt === out.length - 1 ? Math.max(minDist, cornerGap) : minDist;
    if (addInkPoint(out, [x, y, p], { minDist: md, pressureEase })) outRaw.push(i);
  }

  /** Move the filter and the brush toward (x, y) after dt seconds, and emit the brush. */
  function step(x, y, p, dt, i, lazy = prm.lazy / zoom) {
    const vx = (x - f.x) / dt, vy = (y - f.y) / dt;
    const ad = alpha(prm.dCutoff, dt);
    f.vx = ad * vx + (1 - ad) * f.vx;
    f.vy = ad * vy + (1 - ad) * f.vy;
    const speed = Math.hypot(f.vx, f.vy) * zoom; // screen px/s
    const a = alpha(prm.minCutoff + prm.beta * speed, dt);
    f.x = a * x + (1 - a) * f.x;
    f.y = a * y + (1 - a) * f.y;
    const dx = f.x - brush.x, dy = f.y - brush.y, d = Math.hypot(dx, dy);
    if (d > lazy) { brush.x += (dx * (d - lazy)) / d; brush.y += (dy * (d - lazy)) / d; }
    emit(brush.x, brush.y, p, i);
  }

  function process(i) {
    const r = raw[i];
    if (!f) {
      f = { x: r.x, y: r.y, vx: 0, vy: 0, t: r.t };
      brush = { x: r.x, y: r.y };
      emit(r.x, r.y, r.p, i);
      return;
    }
    let dt = (r.t - f.t) / 1000;
    if (!(dt > 0)) dt = 1 / 240; // coalesced samples can share a timestamp: assume the Pencil's 240 Hz
    f.t = r.t;
    step(r.x, r.y, r.p, Math.min(dt, 0.1), i);
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

  /** Keep raw sample j exactly as a corner: rewind the ink to before it, restart the filter there, replay. */
  function applyCorner(j) {
    const tip = raw[j];
    let k = out.length;
    while (k > 1 && outRaw[k - 1] >= j) k--;
    out.length = k; outRaw.length = k;
    while (out.length > 1 && Math.hypot(out[out.length - 1][0] - tip.x, out[out.length - 1][1] - tip.y) < cornerGap) { out.pop(); outRaw.pop(); }
    const prev = out[out.length - 1];
    if (prev && prev[0] === tip.x && prev[1] === tip.y) { out.pop(); outRaw.pop(); }
    out.push([tip.x, tip.y, prev ? prev[2] * (1 - pressureEase) + tip.p * pressureEase : tip.p]);
    outRaw.push(j);
    cornerAt = out.length - 1;
    corners.push(j);
    f = { x: tip.x, y: tip.y, vx: 0, vy: 0, t: tip.t };
    brush = { x: tip.x, y: tip.y };
    anchor = j;
    evalNext = Math.max(evalNext, j + 1);
    for (let i = j + 1; i < raw.length; i++) process(i);
  }

  return {
    points: out, smoothness: clampSmooth(smoothness), corners,
    /** One sample [x, y, pressure] in world units; t in ms (event.timeStamp). */
    add(sample, t) {
      const prevT = raw.length ? raw[raw.length - 1].t : 0;
      raw.push({ x: sample[0], y: sample[1], p: sample[2] ?? 0.5, t: Number.isFinite(t) ? t : prevT + 1000 / 240 });
      lastSample = sample;
      process(raw.length - 1);
      findCorners();
    },
    /** Pen-up: settle any corner, glide the ink onto the last sample and end exactly there. */
    end(sample = lastSample) {
      if (!raw.length) return out;
      if (sample && (sample[0] !== raw[raw.length - 1].x || sample[1] !== raw[raw.length - 1].y)) this.add(sample);
      closeRun();
      const r = raw[raw.length - 1];
      const i = raw.length - 1;
      // a few virtual frames with the string shortening to nothing, so the end is a curve, not a hook
      const N = 8;
      for (let n = 1; n <= N && Math.hypot(brush.x - r.x, brush.y - r.y) > 0.5 / zoom; n++) step(r.x, r.y, r.p, 1 / 120, i, (prm.lazy / zoom) * (1 - n / N));
      return endInk(out, [r.x, r.y, r.p]);
    },
  };
}
