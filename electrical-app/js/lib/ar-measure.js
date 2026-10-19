// AR tape: measure a path along a wall or conduit with the camera, the way
// Apple's Measure app does. Three back ends, best first:
//  1. native: the Fishtape iOS app's ARKit plugin, window.Capacitor.Plugins.FishtapeMeasure
//     (contract in docs/BUILD-PLAN.md: isAvailable(), measurePath({ units })).
//  2. webxr: WebXR 'immersive-ar' with 'hit-test' (Chrome on ARCore Android phones).
//     A reticle sits on the surface under the screen centre; tap to drop points.
//     Rendering is a minimal WebGL 1 renderer, no library.
//  3. none: explain, and let the screen offer the plan trace or a typed length.
// Phone-motion-only measuring (integrating the accelerometer) is deliberately not
// offered: drift makes it wrong within seconds.
//
// Everything that touches the DOM, WebXR or WebGL runs inside functions, so the
// pure helpers at the bottom can be tested in Node.
import { fmtLength } from './units.js';

/** Returned paths: { totalM, segments: [{ lengthM }], points: [{ x, y, z }], snapshot? } (metres). */

export const AR_TIPS = [
  'Good, even light. AR loses track in dim rooms and on shiny surfaces.',
  'Plain white drywall is the hardest surface. Put a few strips of tape on it or aim at edges, outlets and studs.',
  'Move the phone slowly and keep it 30 cm to 1 m (1 to 3 ft) from the surface.',
  'Measure in short legs (under about 3 m / 10 ft) with a point at every bend.',
  'Check a known length first, such as a 1220 mm (4 ft) sheet of drywall.',
];

function nativePlugin() {
  return globalThis.window?.Capacitor?.Plugins?.FishtapeMeasure || null;
}

function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return /iPhone|iPad|iPod/.test(nav.userAgent || '') || (/Macintosh/.test(nav.userAgent || '') && nav.maxTouchPoints > 1);
}

export function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'cancelled';
  return e;
}

export function isCancelled(e) {
  return e === 'cancelled' || e?.code === 'cancelled' || e?.message === 'cancelled' || e?.errorMessage === 'cancelled';
}

let supportPromise = null;
/**
 * Which AR back end this device has: { mode: 'native'|'webxr'|'none', label?, reason? }.
 * Cached; pass { refresh: true } to ask again.
 */
export function getArSupport({ refresh = false } = {}) {
  if (supportPromise && !refresh) return supportPromise;
  supportPromise = (async () => {
    const plugin = nativePlugin();
    if (plugin) {
      try {
        const r = await plugin.isAvailable?.();
        if (!r || r.available !== false) return { mode: 'native', label: 'ARKit' };
        return { mode: 'none', reason: 'This iPhone or iPad does not support ARKit world tracking.' };
      } catch { /* fall through to WebXR */ }
    }
    const xr = globalThis.navigator?.xr;
    if (xr?.isSessionSupported && globalThis.isSecureContext !== false) {
      try { if (await xr.isSessionSupported('immersive-ar')) return { mode: 'webxr', label: 'WebXR' }; } catch { /* not supported */ }
    }
    if (isIOS()) return { mode: 'none', reason: 'Safari on iPhone and iPad has no web AR measuring. It comes with the Fishtape iOS app.' };
    if (globalThis.isSecureContext === false) return { mode: 'none', reason: 'AR needs the app to be opened over https.' };
    return { mode: 'none', reason: 'This browser has no WebXR AR. Use Chrome on an Android phone that supports ARCore, or the Fishtape iOS app.' };
  })();
  return supportPromise;
}

/**
 * Measure a path. Resolves to { totalM, segments, points, snapshot? }; rejects with
 * an error where isCancelled(e) is true when the user backs out.
 * Call it straight from a tap handler: WebXR needs the user's gesture to start.
 */
export async function measurePath({ units = 'metric' } = {}) {
  const plugin = nativePlugin();
  if (plugin) {
    let raw;
    try { raw = await plugin.measurePath({ units }); } catch (e) { throw isCancelled(e) ? cancelledError() : e; }
    return normalizeResult(raw);
  }
  if (globalThis.navigator?.xr) return webxrMeasure({ units });
  throw new Error('AR measuring is not available on this device.');
}

// ---------- WebXR ----------
const COLORS = {
  line: [0.96, 0.70, 0.004, 1], // --accent-fill
  halo: [0.11, 0.106, 0.098, 0.55],
  live: [1, 1, 1, 0.9],
  dot: [1, 1, 1, 1],
  ring: [1, 1, 1, 0.95],
  ringIdle: [1, 1, 1, 0.45],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildOverlay() {
  const root = el('div', 'wr-ar');
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'AR tape');
  const top = el('div', 'wr-ar-top');
  const total = el('div', 'wr-ar-total', '0');
  const leg = el('div', 'wr-ar-leg', '');
  const status = el('div', 'wr-ar-status', 'Starting AR…');
  status.setAttribute('aria-live', 'polite');
  top.append(total, leg, status);
  const cross = el('div', 'wr-ar-cross');
  const bar = el('div', 'wr-ar-bar');
  const btn = (label, cls) => { const b = el('button', `btn ${cls}`, label); b.type = 'button'; return b; };
  const cancel = btn('Cancel', 'ghost');
  const undo = btn('Undo', '');
  const add = btn('Add point', 'primary lg');
  const done = btn('Done', 'dark');
  bar.append(cancel, undo, add, done);
  root.append(top, cross, bar);
  // taps on the controls must not also drop a point in the scene
  for (const b of [top, bar]) b.addEventListener('beforexrselect', (e) => e.preventDefault());
  return { root, total, leg, status, cancel, undo, add, done };
}

async function webxrMeasure({ units }) {
  const ui = buildOverlay();
  document.body.append(ui.root);
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: ui.root },
    });
  } catch (e) {
    ui.root.remove();
    throw new Error(`Could not start AR (${e?.message || e}). Allow camera access and try again.`);
  }
  ui.root.classList.add('on');

  const points = [];
  let reticle = null;
  let finished = false, result = null, ended = false;
  let hitSource = null;
  let lastStatus = '';
  const fmt = (m) => fmtLength(m, { units, denom: 8 });
  const setStatus = (s) => { if (s !== lastStatus) { ui.status.textContent = s; lastStatus = s; } };
  const refresh = () => {
    const legs = legLengthsXYZ(points);
    ui.total.textContent = fmt(legs.reduce((a, b) => a + b, 0));
    ui.undo.disabled = !points.length;
    ui.done.disabled = points.length < 2;
  };
  refresh();

  return new Promise((resolve, reject) => {
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      result = ok ? pathFromPoints(points) : null;
      session.end().catch(() => {});
    };
    const addPoint = () => {
      if (!reticle) { setStatus('No surface under the dot yet. Move slowly so the camera can find it.'); return; }
      points.push({ ...reticle.position });
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
      refresh();
    };
    ui.add.addEventListener('click', addPoint);
    ui.undo.addEventListener('click', () => { points.pop(); refresh(); });
    ui.done.addEventListener('click', () => { if (points.length >= 2) finish(true); });
    ui.cancel.addEventListener('click', () => finish(false));
    session.addEventListener('select', addPoint);
    session.addEventListener('end', () => {
      ended = true;
      try { hitSource?.cancel(); } catch { /* already gone */ }
      ui.root.remove();
      // Leaving AR another way (back button, or no DOM overlay so no Done button) with 2+ points
      // keeps the measurement; the screen asks before adding it.
      if (!finished && points.length >= 2) result = pathFromPoints(points);
      if (result) resolve(result); else reject(cancelledError());
    });

    (async () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: true });
      if (!gl) throw new Error('WebGL is not available.');
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');
      hitSource = await session.requestHitTestSource({ space: viewerSpace });
      const renderer = createRenderer(gl);
      const onFrame = (t, frame) => {
        if (ended) return;
        session.requestAnimationFrame(onFrame);
        const layer = session.renderState.baseLayer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const pose = frame.getViewerPose(refSpace);
        if (!pose) { reticle = null; setStatus('Finding the room. Move the phone slowly.'); return; }
        const hits = frame.getHitTestResults(hitSource);
        const hp = hits.length ? hits[0].getPose(refSpace) : null;
        reticle = hp ? { matrix: Array.from(hp.transform.matrix), position: xyz(hp.transform.position) } : null;
        if (!reticle) setStatus('Aim the dot at the wall or conduit and move slowly.');
        else setStatus(points.length ? 'Tap to add the next point. Done when finished.' : 'Tap to drop the first point.');
        const last = points[points.length - 1];
        ui.leg.textContent = last && reticle ? `+ ${fmt(dist(last, reticle.position))}` : '';
        for (const view of pose.views) {
          const vp = layer.getViewport(view);
          gl.viewport(vp.x, vp.y, vp.width, vp.height);
          const cam = { position: xyz(view.transform.position), matrix: Array.from(view.transform.matrix) };
          renderer.draw(view.projectionMatrix, view.transform.inverse.matrix, sceneGeometry(points, reticle, cam));
        }
      };
      session.requestAnimationFrame(onFrame);
    })().catch((e) => {
      finished = true;
      session.end().catch(() => {});
      reject(new Error(`AR stopped: ${e?.message || e}`));
    });
  });
}

function createRenderer(gl) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec3 p;uniform mat4 proj;uniform mat4 view;void main(){gl_Position=proj*view*vec4(p,1.0);}'));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, 'precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}'));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
  const aP = gl.getAttribLocation(prog, 'p');
  const uProj = gl.getUniformLocation(prog, 'proj');
  const uView = gl.getUniformLocation(prog, 'view');
  const uColor = gl.getUniformLocation(prog, 'color');
  const buf = gl.createBuffer();
  return {
    draw(proj, view, scene) {
      gl.useProgram(prog);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniformMatrix4fv(uView, false, view);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aP);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      const pass = (verts, color) => {
        if (!verts.length) return;
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.uniform4fv(uColor, color);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 3);
      };
      pass(scene.halo, COLORS.halo);
      pass(scene.lines, COLORS.line);
      pass(scene.live, COLORS.live);
      pass(scene.dots, COLORS.dot);
      pass(scene.ring, scene.ringActive ? COLORS.ring : COLORS.ringIdle);
    },
  };
}

// ---------- pure helpers (tested in Node) ----------
const xyz = (p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 });
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const arr = (p) => [p.x, p.y, p.z];

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function legLengthsXYZ(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push(dist(points[i - 1], points[i]));
  return out;
}

/** Points (metres) -> { totalM, segments: [{ lengthM }], points }. */
export function pathFromPoints(points) {
  const pts = points.map(xyz);
  const legs = legLengthsXYZ(pts);
  return { totalM: legs.reduce((a, b) => a + b, 0), segments: legs.map((lengthM) => ({ lengthM })), points: pts };
}

/**
 * Check and tidy what a back end returned. Fills segments from points when the
 * plugin sent only points, and totalM from the segments when it is missing.
 */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('No measurement came back.');
  const pts = Array.isArray(raw.points) ? raw.points.filter((p) => p && [p.x, p.y].every((v) => Number.isFinite(Number(v)))).map(xyz) : [];
  let legs = Array.isArray(raw.segments) ? raw.segments.map((s) => Number(s?.lengthM)).filter((v) => Number.isFinite(v) && v >= 0) : [];
  if (!legs.length && pts.length > 1) legs = legLengthsXYZ(pts);
  const t = Number(raw.totalM);
  const totalM = Number.isFinite(t) && t > 0 ? t : legs.reduce((a, b) => a + b, 0);
  if (!(totalM > 0)) throw new Error('The measurement was empty.');
  const out = { totalM, segments: legs.map((lengthM) => ({ lengthM })), points: pts };
  if (typeof raw.snapshot === 'string' && /^data:image\/jpeg;base64,/.test(raw.snapshot)) out.snapshot = raw.snapshot;
  return out;
}

/** Column-major 4x4 transform of a point. */
export function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Two triangles for a flat strip from a to b, turned to face the eye. */
export function ribbon(a, b, eye, half) {
  const A = arr(a), B = arr(b);
  const d = sub(B, A);
  const mid = scale(add(A, B), 0.5);
  let side = cross(d, sub(arr(eye), mid));
  const l = len(side);
  if (l < 1e-9) return [];
  side = scale(side, half / l);
  const a0 = sub(A, side), a1 = add(A, side), b0 = sub(B, side), b1 = add(B, side);
  return [...a0, ...a1, ...b1, ...a0, ...b1, ...b0];
}

/** A square of half-size `s` around p, facing the camera (right/up from its matrix). */
export function billboard(p, camMatrix, s) {
  const right = scale([camMatrix[0], camMatrix[1], camMatrix[2]], s);
  const up = scale([camMatrix[4], camMatrix[5], camMatrix[6]], s);
  const P = arr(p);
  const c = [sub(sub(P, right), up), add(sub(P, up), right), add(add(P, right), up), add(sub(P, right), up)];
  return [...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]];
}

/** A flat ring lying in the hit pose's surface plane (its local X-Z plane; Y is the normal). */
export function ring(matrix, r0, r1, n = 32) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2;
    const i0 = transformPoint(matrix, r0 * Math.cos(t0), 0, r0 * Math.sin(t0));
    const o0 = transformPoint(matrix, r1 * Math.cos(t0), 0, r1 * Math.sin(t0));
    const i1 = transformPoint(matrix, r0 * Math.cos(t1), 0, r0 * Math.sin(t1));
    const o1 = transformPoint(matrix, r1 * Math.cos(t1), 0, r1 * Math.sin(t1));
    out.push(...i0, ...o0, ...o1, ...i0, ...o1, ...i1);
  }
  return out;
}

/** Everything to draw this frame, as Float32Arrays of triangle vertices (metres). */
export function sceneGeometry(points, reticle, cam) {
  const lines = [], halo = [], dots = [], live = [];
  for (let i = 1; i < points.length; i++) {
    halo.push(...ribbon(points[i - 1], points[i], cam.position, 0.0045));
    lines.push(...ribbon(points[i - 1], points[i], cam.position, 0.0025));
  }
  for (const p of points) dots.push(...billboard(p, cam.matrix, 0.006));
  const last = points[points.length - 1];
  if (last && reticle) live.push(...ribbon(last, reticle.position, cam.position, 0.0015));
  const ringVerts = reticle ? [...ring(reticle.matrix, 0.03, 0.038), ...billboard(reticle.position, cam.matrix, 0.003)] : [];
  return {
    lines: new Float32Array(lines), halo: new Float32Array(halo), dots: new Float32Array(dots),
    live: new Float32Array(live), ring: new Float32Array(ringVerts), ringActive: !!reticle,
  };
}
