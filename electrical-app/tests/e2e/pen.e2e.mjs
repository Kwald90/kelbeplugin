// Canvas pen input in headless Chrome, on the demo (no server needed): writes "TRAVIS" fast with
// a pen (trusted CDP pen events, and synthesized PointerEvents with pressure and coalesced
// samples) and checks every letter's strokes and the V's corner; a pointercancel mid-V keeps the
// stroke; a palm landing mid-V is ignored; a fast eraser swipe; finger pan and pinch; mouse and
// finger drawing.
//   node electrical-app/tests/e2e/pen.e2e.mjs [appDir] [port] [profileDir]
// Needs python (static server) and Chrome (CHROME_PATH to override).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const APPDIR = process.argv[2] || fileURLToPath(new URL('../../', import.meta.url));
const PORT = process.argv[3] || '8731';
const PROFILE = process.argv[4] || join(mkdtempSync(join(tmpdir(), 'fishtape-pen-')), 'profile');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(PORT) + 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); };

const py = spawn('python', ['-m', 'http.server', PORT, '--bind', '127.0.0.1'], { cwd: APPDIR, stdio: 'ignore' });
rmSync(PROFILE, { recursive: true, force: true }); mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${PROFILE}`,
  '--window-size=1180,820', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { py.kill(); } catch {} };
process.on('exit', cleanup);

let ws, seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(100); }
  throw new Error('timeout waiting for ' + expr);
}

// ---- letters, screen coords, origin ox,oy, 60px tall glyphs. Each letter is a list of strokes.
function letters(ox, oy) {
  const L = (dx, pts) => pts.map(([x, y]) => [ox + dx + x, oy + y]);
  return {
    T: [L(0, [[0, 0], [50, 0]]), L(0, [[25, 0], [25, 60]])],
    R: [L(70, [[0, 60], [0, 0]]), L(70, [[0, 0], [30, 3], [38, 15], [30, 27], [0, 30], [40, 60]])],
    A: [L(130, [[0, 60], [22, 0], [44, 60]]), L(130, [[10, 34], [34, 34]])],
    V: [L(195, [[0, 0], [24, 60], [48, 0]])],
    I: [L(265, [[0, 0], [0, 60]])],
    S: [L(290, [[40, 5], [20, 0], [2, 12], [20, 30], [38, 45], [20, 60], [0, 55]])],
  };
}
// densify a polyline into fast samples: `step` px apart (big step = fast stroke)
function samples(poly, step = 9) {
  const out = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1], [bx, by] = poly[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

async function openCanvas() {
  const inApp = await ev(`location.port === "${PORT}"`).catch(() => false);
  if (!inApp) {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch {} await sleep(200); }
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await waitFor(`[...document.querySelectorAll('button')].some((b) => /Try the demo/.test(b.textContent))`);
    // answer the first-run "How do you measure?" sheet up front so it doesn't cover the canvas
    await ev(`localStorage.setItem('ft.units', 'imperial')`);
    await ev(`[...document.querySelectorAll('button')].find((b) => /Try the demo/.test(b.textContent)).click()`);
    await sleep(800);
  } else {
    await ev(`location.hash = '#/drawings'`);
    await sleep(500);
  }
  const prev = await ev(`globalThis.kelbeCanvas?.d?.id || ''`);
  await ev(`location.hash = '#/drawings/new'`);
  await waitFor(`!!globalThis.kelbeCanvas && kelbeCanvas.d.id !== ${JSON.stringify(prev)} && !!document.querySelector('.cv-canvas')`);
  await sleep(300);
  await ev(`kelbeCanvas.setTool('pen')`);
}
const state = () => ev(`(() => { const k = kelbeCanvas; return { n: k.d.strokes.length, view: { ...k.st.view }, strokes: k.d.strokes.map((s) => ({ tool: s.tool, pts: s.points.map((p) => [p[0], p[1]]) })) }; })()`);
const toWorld = (v, [sx, sy]) => [(sx - v.x) / v.zoom, (sy - v.y) / v.zoom];
const canvasOrigin = () => ev(`(() => { const r = document.querySelector('.cv-canvas').getBoundingClientRect(); return [r.left, r.top]; })()`);

// trusted pen via CDP (pointerType pen, with force)
async function cdpPenStroke(pts) {
  const base = { pointerType: 'pen', button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1, force: 0.4 });
  for (const [x, y] of pts.slice(1)) await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y, buttons: 1, force: 0.6 });
  const l = pts[pts.length - 1];
  await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: l[0], y: l[1], buttons: 0, force: 0 });
}
async function cdpMouseStroke(pts) {
  const base = { button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: pts[0][0], y: pts[0][1], buttons: 1 });
  for (const [x, y] of pts.slice(1)) await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y, buttons: 1 });
  const l = pts[pts.length - 1];
  await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: l[0], y: l[1], buttons: 0 });
}
async function cdpTouch(type, points) {
  await send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 10, radiusY: 10, force: 1 })) });
}

// synthesized PointerEvents in the page: pen, pressure, coalesced samples (4 per event),
// optional pointercancel after `cancelAt` events and a palm touch landing at `palmAt`.
async function synthStroke(pts, opt = {}) {
  return ev(`(async () => {
    const cv = document.querySelector('.cv-canvas');
    const pts = ${JSON.stringify(pts)}, opt = ${JSON.stringify(opt)};
    const id = opt.id || 77, palm = 500;
    const mk = (type, x, y, extra = {}) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: 'pen', isPrimary: true,
      clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.6, buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0, ...extra });
    cv.dispatchEvent(mk('pointerdown', pts[0][0], pts[0][1]));
    let i = 1, n = 0;
    while (i < pts.length) {
      const chunk = pts.slice(i, i + 4); i += chunk.length; n++;
      const co = chunk.map(([x, y]) => mk('pointermove', x, y));
      const [lx, ly] = chunk[chunk.length - 1];
      cv.dispatchEvent(mk('pointermove', lx, ly, { coalescedEvents: co }));
      if (opt.palmAt === n) {
        const t = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: palm, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5 });
        cv.dispatchEvent(t('pointerdown', lx + 120, ly + 90));
        cv.dispatchEvent(t('pointermove', lx + 160, ly + 140));
        cv.dispatchEvent(t('pointermove', lx + 200, ly + 180));
        if (opt.palmUpEarly) cv.dispatchEvent(t('pointerup', lx + 200, ly + 180));
        else opt.palmUpLate = true;
      }
      if (opt.cancelAt === n) { cv.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: id, pointerType: 'pen', isPrimary: true, clientX: 0, clientY: 0 })); return 'cancelled'; }
      await new Promise((r) => requestAnimationFrame(r));
    }
    const [x, y] = pts[pts.length - 1];
    cv.dispatchEvent(mk('pointerup', x, y));
    if (opt.palmUpLate) cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: palm, pointerType: 'touch', isPrimary: true, clientX: 600, clientY: 600 }));
    return 'done';
  })()`);
}

function hasCorner(stroke, tipW, tol = 0.6) {
  const near = stroke.pts.some((p) => Math.hypot(p[0] - tipW[0], p[1] - tipW[1]) <= tol);
  const lowest = Math.max(...stroke.pts.map((p) => p[1]));
  return near && Math.abs(lowest - tipW[1]) <= tol;
}

async function writeTravis(strokeFn, ox, oy, label) {
  const [cx, cy] = await canvasOrigin();
  const before = await state();
  const G = letters(ox + cx, oy + cy);
  const counts = {};
  for (const [ch, strokes] of Object.entries(G)) {
    for (const s of strokes) { await strokeFn(samples(s, 11)); await sleep(30); }
    counts[ch] = strokes.length;
  }
  await sleep(150);
  const after = await state();
  const added = after.strokes.slice(before.n);
  const want = Object.values(counts).reduce((a, b) => a + b, 0);
  check(`${label}: TRAVIS gives ${want} strokes, one per letter stroke`, added.length === want, `got ${added.length}`);
  if (added.length !== want) for (const s of added) console.log('   stroke', s.pts.length, JSON.stringify(s.pts[0].map((n) => Math.round(n))), '->', JSON.stringify(s.pts[s.pts.length - 1].map((n) => Math.round(n))));
  // V is stroke index 7 (T2 R2 A2 V1)
  const v = added[6];
  const tip = toWorld(after.view, [ox + 195 + 24, oy + 60]);
  check(`${label}: V is one stroke with its corner`, !!v && hasCorner(v, tip), v ? `pts ${v.pts.length}` : 'missing');
  const a = added[4];
  const apex = toWorld(after.view, [ox + 130 + 22, oy]);
  check(`${label}: A keeps its apex`, !!a && a.pts.some((p) => Math.hypot(p[0] - apex[0], p[1] - apex[1]) <= 0.6) && Math.abs(Math.min(...a.pts.map((p) => p[1])) - apex[1]) <= 0.6);
  check(`${label}: view did not move while writing`, JSON.stringify(before.view) === JSON.stringify(after.view));
  return added;
}

try {
  await connect();
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await openCanvas();

  // 1. trusted CDP pen, fast
  // headless Chrome drops the very first input after load (no hit-test data yet): a probe
  // showed zero pointer events reaching the page for it, on the old code and the new.
  // Warm up with a hover and wait for the first event to reach the canvas.
  await waitFor(`document.elementFromPoint(250, 170)?.classList.contains('cv-canvas')`);
  await ev(`window.__seen = 0; document.querySelector('.cv-canvas').addEventListener('pointermove', () => __seen++)`);
  for (let i = 0; i < 20 && !(await ev('__seen')); i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600 + i, y: 500, pointerType: 'pen' }); await sleep(100); }
  await ev(`window.__errs = []; addEventListener('error', (e) => __errs.push(e.message)); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)))`);
  await writeTravis(cdpPenStroke, 120, 160, 'CDP pen');
  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(PROFILE + '-travis.png', Buffer.from(shot.data, 'base64'));
  check('no page errors while drawing', (await ev('__errs.length')) === 0, await ev('JSON.stringify(__errs)'));
  const svg = await ev(`(async () => (await import('./js/canvas/engine.js')).toSVG(kelbeCanvas.d))()`);
  check('SVG export of the strokes works', /<path d="M[^"]*L/.test(svg));

  // 2. synthesized pen with coalesced events
  await writeTravis((pts) => synthStroke(pts), 120, 300, 'Synth pen+coalesced');

  // 3. pointercancel mid-V: what was drawn is kept
  {
    const [cx, cy] = await canvasOrigin();
    const b = await state();
    const V = samples([[600 + cx, 160 + cy], [624 + cx, 220 + cy], [648 + cx, 160 + cy]], 11);
    const r = await synthStroke(V, { cancelAt: 3, id: 91 });
    await sleep(100);
    const a = await state();
    const s = a.strokes[a.n - 1];
    const tip = toWorld(a.view, [624 + cx, 220 + cy]);
    check('pointercancel mid-V keeps the stroke', r === 'cancelled' && a.n === b.n + 1 && s.pts.length >= 4, `n ${b.n}->${a.n}`);
    check('pointercancel after the tip keeps the corner', !!s && hasCorner(s, tip));
    check('no point at the cancel event\'s 0,0', !s.pts.some((p) => { const w = toWorld(a.view, [cx, cy]); return Math.hypot(p[0] - w[0], p[1] - w[1]) < 1; }));
    // pen still works right after
    await synthStroke(samples([[700 + cx, 160 + cy], [740 + cx, 200 + cy]], 11), { id: 92 });
    check('pen works after a cancel', (await state()).n === a.n + 1);
  }

  // 4. palm lands (and lifts, or stays) mid-V
  for (const early of [true, false]) {
    const [cx, cy] = await canvasOrigin();
    await sleep(400);
    const b = await state();
    const V = samples([[800 + cx, 160 + cy], [824 + cx, 220 + cy], [848 + cx, 160 + cy]], 6);
    await synthStroke(V, { palmAt: 2, palmUpEarly: early, id: early ? 93 : 94 });
    await sleep(100);
    const a = await state();
    const s = a.strokes[a.n - 1];
    const tip = toWorld(a.view, [824 + cx, 220 + cy]);
    const tag = early ? 'palm down+up mid-V' : 'palm resting through V';
    check(`${tag}: one stroke added`, a.n === b.n + 1, `n ${b.n}->${a.n}`);
    check(`${tag}: V corner kept, nothing from the palm`, !!s && hasCorner(s, tip) && s.pts.every((p) => p[1] <= tip[1] + 0.6));
    check(`${tag}: view not panned`, JSON.stringify(a.view) === JSON.stringify(b.view));
  }

  // 5. finger pan and pinch still work when the pen is up
  {
    await sleep(500);
    const b = await state();
    await cdpTouch('touchStart', [[500, 600]]);
    for (let i = 1; i <= 6; i++) await cdpTouch('touchMove', [[500 + i * 15, 600 + i * 5]]);
    await cdpTouch('touchEnd', []);
    await sleep(100);
    const a = await state();
    check('finger pans after the pen has been used', a.n === b.n && Math.abs(a.view.x - b.view.x - 90) < 2 && Math.abs(a.view.y - b.view.y - 30) < 2, `dx ${a.view.x - b.view.x}`);
    await cdpTouch('touchStart', [[450, 500], [550, 500]]);
    for (let i = 1; i <= 6; i++) await cdpTouch('touchMove', [[450 - i * 10, 500], [550 + i * 10, 500]]);
    await cdpTouch('touchEnd', []);
    await sleep(100);
    const c = await state();
    check('two-finger pinch zooms', c.n === a.n && c.view.zoom > a.view.zoom * 1.5, `zoom ${a.view.zoom} -> ${c.view.zoom}`);
    // and the pen draws right after a pinch
    await sleep(100);
    await cdpPenStroke(samples([[300, 650], [360, 700]], 11));
    check('pen draws after a pinch', (await state()).n === c.n + 1);
  }

  // 5b. a quick eraser swipe removes every stroke it crosses, not just those under the samples
  {
    await openCanvas();
    for (const x of [300, 340, 380, 420]) await cdpPenStroke(samples([[x, 300], [x, 400]], 11));
    const b = await state();
    await ev(`kelbeCanvas.setTool('eraser')`);
    await cdpPenStroke([[270, 350], [450, 350]]); // one jump across all four
    const a = await state();
    check('fast eraser swipe removes all four crossed strokes', b.n === 4 && a.n === 0, `${b.n} -> ${a.n}`);
    await ev(`kelbeCanvas.setTool('pen')`);
  }

  // 6. mouse drawing (fresh drawing, no pen seen)
  {
    await openCanvas();
    await ev(`kelbeCanvas.st.penSeen`).then((v) => v === false || console.log('note: penSeen carried over'));
    const added = await writeTravis(cdpMouseStroke, 120, 200, 'Mouse');
    check('mouse strokes are pen tool', added.every((s) => s.tool === 'pen'));
  }

  // 7. finger drawing before any pen (no penSeen): one finger draws, still works
  {
    await openCanvas();
    const b = await state();
    await cdpTouch('touchStart', [[300, 300]]);
    for (let i = 1; i <= 6; i++) await cdpTouch('touchMove', [[300 + i * 12, 300 + i * 12]]);
    await cdpTouch('touchEnd', []);
    await sleep(100);
    check('finger draws before a pen is seen', (await state()).n === b.n + 1);
  }
} catch (err) {
  check('run', false, err.stack);
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}
