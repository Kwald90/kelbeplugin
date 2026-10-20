// Landing page + HQ Promotions, end to end: embedded Postgres 17 + the API in-process + a static
// server that serves /, /site/, /hq/, /media/ (with ranges) and proxies /api/ like nginx, sending
// the staging CSP, and headless Chrome over CDP.
//   cd server && npm ci          (embedded-postgres, pg, otplib come from server/node_modules)
//   node electrical-app/tests/e2e/landing.e2e.mjs [scratch dir]
// Needs ffmpeg on PATH (three 3-second H.264 test clips, desktop and phone cuts, and posters).
// CHROME_PATH overrides the Chrome binary. Not part of `node --test electrical-app/tests/*.test.mjs`.
//
// What it proves: the default promotion with no videos; HQ sign-in, upload, create with a live
// preview; the handover between clips never shows a blank frame (composited frames sampled
// around every switch, including the loop back to the first); pause; dots and keyboard;
// pausing off-screen; reduced motion and Save-Data (posters, slow crossfade); an HQ edit
// reaching the public page; phone width (9:16 sources, no sideways scroll); no layout shift;
// and a console with no errors or warnings on the public pages (CSP violations included).
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, createReadStream, mkdtempSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-landing-e2e-'));
mkdirSync(SCRATCH, { recursive: true });
const SERVER = join(WT, 'server');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mod = (p) => import(pathToFileURL(join(SERVER, p)).href);
const ESM = { 'embedded-postgres': 'dist/index.js', otplib: 'dist/index.js', pg: 'esm/index.mjs' };
const pkg = (name) => import(pathToFileURL(join(SERVER, 'node_modules', name, ESM[name])).href);

const EmbeddedPostgres = (await pkg('embedded-postgres')).default;
const { generate } = await pkg('otplib');
const { runPsqlScript } = await mod('test/support/psql-lite.js');
const { migrate } = await mod('src/migrate.js');
const { createDb, createPool } = await mod('src/db.js');
const { readConfig } = await mod('src/config.js');
const { buildApp } = await mod('src/app.js');
const { hashSecret } = await mod('src/auth/passwords.js');
const pg = (await pkg('pg')).default;

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = () => randomBytes(18).toString('base64url');
const J = JSON.stringify;
function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ---------- test clips (ffmpeg) ----------
const CLIPS = [
  { name: 'clip-1', rgb: [230, 126, 34] },  // orange
  { name: 'clip-2', rgb: [22, 160, 133] },  // teal
  { name: 'clip-3', rgb: [142, 68, 173] },  // purple
];
const clipDir = join(SCRATCH, 'clips');
mkdirSync(clipDir, { recursive: true });
const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
}
for (const c of CLIPS) {
  for (const [suffix, size] of [['', '640x360'], ['-m', '360x640']]) {
    const out = join(clipDir, `${c.name}${suffix}.mp4`);
    if (!existsSync(out)) {
      // A solid colour with moving grain (so every frame differs), H.264 baseline, no audio, faststart.
      ff(['-f', 'lavfi', '-i', `color=c=0x${hex(c.rgb)}:s=${size}:d=3:r=30`, '-vf', 'noise=alls=12:allf=t', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
    }
  }
  const poster = join(clipDir, `${c.name}.jpg`);
  if (!existsSync(poster)) ff(['-i', join(clipDir, `${c.name}.mp4`), '-frames:v', '1', '-q:v', '3', poster]);
}
log('test clips ready in', clipDir);

// ---------- Postgres, API, static + proxy ----------
const pgPort = await freePort();
const superPw = pw();
const pgServer = new EmbeddedPostgres({ databaseDir: join(SCRATCH, `pg-${Date.now()}`, 'data'), port: pgPort, user: 'postgres', password: superPw, authMethod: 'scram-sha-256', persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
await pgServer.initialise();
await pgServer.start();
const superUrl = `postgres://postgres:${encodeURIComponent(superPw)}@127.0.0.1:${pgPort}/postgres`;
const roles = { owner_password: pw(), app_password: pw(), hq_password: pw() };
await runPsqlScript(readFileSync(join(SERVER, 'db/bootstrap.sql'), 'utf8'), superUrl, roles);
const dbUrl = (user, p) => `postgres://${user}:${encodeURIComponent(p)}@127.0.0.1:${pgPort}/fishtape`;
const ownerClient = new pg.Client({ connectionString: dbUrl('fishtape_owner', roles.owner_password) });
await ownerClient.connect();
await migrate(ownerClient);
await ownerClient.end();
const superDb = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(superPw)}@127.0.0.1:${pgPort}/fishtape` });
await superDb.connect();
const db = createDb({ app: createPool(dbUrl('fishtape_app', roles.app_password), { max: 8 }), hq: createPool(dbUrl('fishtape_hq', roles.hq_password), { max: 2 }) });
const ADMIN = { email: 'kelvin-e2e@fishtape.test', password: `hq-${pw()}` };
await superDb.query("INSERT INTO users (email, display_name, password_hash, platform_role) VALUES ($1, 'Kelvin (e2e)', $2, 'hq_admin')", [ADMIN.email, await hashSecret(ADMIN.password)]);

const mediaDir = join(SCRATCH, `media-${Date.now()}`);
mkdirSync(mediaDir, { recursive: true });
const apiPort = await freePort();
const webPort = await freePort();
const ORIGIN = `http://localhost:${webPort}`;
const config = readConfig({ APP_ENV: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: dbUrl('fishtape_app', roles.app_password), RATE_LIMIT: 'off', LOG_LEVEL: 'warn', PORT: String(apiPort) });
config.hq = { tlsCheck: false };
config.media = { dir: mediaDir };
const api = await buildApp({ config, db });
await api.listen({ port: apiPort, host: '127.0.0.1' });

// The CSP exactly as nginx sends it (minus upgrade-insecure-requests, which is about https).
const CSP = /add_header Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(WT, 'deploy/staging/security-headers.conf'), 'utf8'))[1].replace(/;\s*upgrade-insecure-requests/, '');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const web = createServer((rq, rs) => {
  const url = new URL(rq.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, method: rq.method, path: rq.url, headers: { ...rq.headers, 'x-forwarded-for': '127.0.0.1' } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    up.on('error', () => { if (!rs.headersSent) { rs.writeHead(502); rs.end(); } });
    rq.pipe(up);
    return;
  }
  const [base, prefix] = url.pathname.startsWith('/site/') ? [WT, ''] : url.pathname.startsWith('/hq/') ? [WT, ''] : url.pathname.startsWith('/media/') ? [mediaDir, '/media'] : [join(WT, 'electrical-app'), ''];
  let p = normalize(join(base, decodeURIComponent(url.pathname.slice(prefix.length))));
  if (!p.startsWith(resolvePath(base))) { rs.writeHead(403); rs.end(); return; }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { rs.writeHead(404, { 'content-type': 'text/plain' }); rs.end('not found'); return; }
  const size = statSync(p).size;
  const headers = { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rq.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    rs.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(p, { start, end }).pipe(rs);
    return;
  }
  rs.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(p).pipe(rs);
});
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));
log('web on', ORIGIN);

// ---------- Chrome over CDP ----------
const cdpPort = await freePort();
const profile = join(SCRATCH, `chrome-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const waiting = new Map();
const consoleLines = [];
let currentUrl = '';
let screencast = null; // frames while recording
const note = (kind, text) => consoleLines.push({ kind, text, page: currentUrl });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type)) note(msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  else if (msg.method === 'Runtime.exceptionThrown') note('exception', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  else if (msg.method === 'Page.screencastFrame') {
    send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
    screencast?.push({ data: msg.params.data, meta: msg.params.metadata, t: Date.now() });
  }
  else if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) note(`log-${msg.params.entry.level}`, `${msg.params.entry.text} ${msg.params.entry.url || ''}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('DOM.enable');

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await evaluate(expression); if (v) return v; } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.split('\n')[0]})` : ''}`);
}
const goto = async (path) => {
  await send('Page.navigate', { url: 'about:blank' }); await sleep(100);
  currentUrl = path;
  await send('Page.navigate', { url: ORIGIN + path });
  await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load');
};
const fill = (sel, val) => evaluate(`(() => { const el = document.querySelector(${J(sel)}); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); el.value = ${J(val)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return true; })()`);
const click = (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a')].find((b) => b.textContent.trim() === ${J(text)} && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)}); el.click(); return true; })()`);
async function shot(name) {
  try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${name}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ }
}
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
    log('PASS', name, detail ?? '');
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    log('FAIL', name, e.message);
    await shot(`fail-${results.length}`);
    throw e;
  }
}
const hero = (expr) => evaluate(`(() => { const h = document.getElementById('hero'); const p = h.heroPlayer; return ${expr}; })()`);

// ---------- frame sampling ----------
/** Minimal PNG decoder (8-bit RGB/RGBA, not interlaced): what Chrome's screenshots are. */
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`PNG colour type ${ct}`); })();
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x], a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[row - stride + x] : 0, c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[row + x] = r & 255;
    }
  }
  return { w, h, bpp, px: out };
}
/** Mean colour and the darkest pixel's luminance in a page region of the composited frame. */
async function sample(clip) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 0.25 }, captureBeyondViewport: false });
  const { w, h, bpp, px } = decodePng(Buffer.from(data, 'base64'));
  let r = 0, g = 0, b = 0, minL = 255;
  for (let i = 0; i < w * h; i++) {
    const R = px[i * bpp], G = px[i * bpp + 1], B = px[i * bpp + 2];
    r += R; g += G; b += B;
    minL = Math.min(minL, 0.2126 * R + 0.7152 * G + 0.0722 * B);
  }
  const n = w * h;
  return { rgb: [r / n, g / n, b / n], minL, t: Date.now() };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Distance from colour p to the mix line between a and b (a crossfade is exactly such a mix). */
function distToMix(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

/**
 * Sample the composited hero for `ms`, classify every frame as clip k, a crossfade k->k+1, or
 * anything else (a blank, black or foreign frame). Returns the sequence and the bad frames.
 */
async function watchHandovers(clip, colours, ms) {
  // Every frame the compositor produces (Page.startScreencast sends one per new frame, up to
  // the display rate), cropped to the region. Then, separately, direct screenshots of the
  // region as a cross-check (taking those while casting would resize the cast frames).
  screencast = [];
  await send('Page.startScreencast', { format: 'png', maxWidth: 640, maxHeight: 640, everyNthFrame: 1 });
  await sleep(ms);
  await send('Page.stopScreencast');
  const shots = [];
  const end = Date.now() + Math.min(ms, 4000);
  while (Date.now() < end) shots.push(await sample(clip));
  const cast = screencast.map((f) => {
    const { w, h, bpp, px } = decodePng(Buffer.from(f.data, 'base64'));
    const k = w / f.meta.deviceWidth;
    const [x0, y0, x1, y1] = [Math.floor(clip.x * k), Math.floor((clip.y + (f.meta.offsetTop || 0)) * k), Math.min(w, Math.ceil((clip.x + clip.width) * k)), Math.min(h, Math.ceil((clip.y + clip.height) * k))];
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * bpp; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    return { rgb: [r / n, g / n, b / n], t: f.t };
  });
  screencast = null;
  const frames = [...cast, ...shots]; // in time order: the cast, then the screenshots
  const n = colours.length;
  const bad = [];
  const seqOut = [];
  for (const f of frames) {
    const near = colours.map((c) => dist(f.rgb, c));
    const k = near.indexOf(Math.min(...near));
    if (near[k] < 30) { if (seqOut.at(-1) !== k) seqOut.push(k); continue; }
    const mixes = colours.map((c, i) => distToMix(f.rgb, c, colours[(i + 1) % n]));
    if (Math.min(...mixes) < 30) continue; // mid-crossfade between neighbours
    bad.push({ rgb: f.rgb.map(Math.round), minL: Math.round(f.minL) });
  }
  return { frames: frames.length, screencastFrames: cast.length, perSecond: Math.round((frames.length / ms) * 1000), seq: seqOut, bad };
}

const clipColours = CLIPS.map((c) => c.rgb);
let exitCode = 0;
let media = {};
let promoId = null;

try {
  await step('Chrome can play the H.264 test clips', async () => {
    await goto('/site/index.html');
    const can = await evaluate('document.createElement("video").canPlayType(\'video/mp4; codecs="avc1.42E01E"\')');
    if (!can) throw new Error('this Chrome cannot play H.264');
    return `canPlayType: ${can}`;
  });

  await step('landing with an empty database: built-in default, posters only, 3 dots, CLS ~0', async () => {
    await evaluate(`window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); true`);
    await waitFor('document.getElementById("hero").heroPlayer?.state', 'hero started');
    const s = await hero('({ ...p.state, headline: h.querySelector(".hero-headline").textContent, cta: h.querySelector(".hero-primary").getAttribute("href"), note: h.querySelector(".hero-note").textContent, poster: h.querySelector(".hero-layer.is-front img").naturalWidth, dots: h.querySelectorAll(".hero-dot").length, videos: h.querySelectorAll("video").length })');
    if (s.mode !== 'posters' || s.headline !== 'Built for Canadian electricians' || s.dots !== 3 || s.videos !== 0 || !s.poster) throw new Error(J(s));
    if (!/signup\.html\?plan=/.test(s.cta) || !/\$1 deposit/.test(s.note)) throw new Error(J(s));
    await sleep(1500);
    const cls = await evaluate('window.__cls');
    if (cls > 0.02) throw new Error(`layout shift ${cls}`);
    const plans = await evaluate('[...document.querySelectorAll("#land-plans .site-plan h3")].map((e) => e.textContent).join(", ")');
    const lazy = await evaluate('[...document.querySelectorAll(".land-feature img")].every((i) => i.loading === "lazy" && i.width && i.height)');
    if (!lazy) throw new Error('feature images are not lazy with dimensions');
    await shot('01-landing-default');
    return `mode ${s.mode}, CLS ${cls.toFixed(4)}, plans: ${plans}`;
  });

  await step('HQ: sign in with two-step set-up, open Promotions', async () => {
    await goto('/hq/');
    await waitFor('!!document.querySelector(".hq-signin input[name=email]")', 'HQ sign-in');
    await fill('.hq-signin input[name=email]', ADMIN.email);
    await fill('.hq-signin input[name=password]', ADMIN.password);
    await click('Sign in', '.hq-signin');
    await waitFor('!!document.querySelector(".hq-secret")', 'TOTP set-up');
    const secret = (await evaluate('document.querySelector(".hq-secret").textContent')).replace(/\s+/g, '');
    await fill('.hq-signin input[name=code]', await generate({ secret }));
    await click('Turn on two-step sign-in', '.hq-signin');
    await waitFor('!!document.querySelector(".hq-codes")', 'recovery codes');
    await click('I saved them', '.hq-signin');
    await waitFor('!!document.querySelector(".rail [data-page=promotions]")', 'HQ console with a Promotions entry');
    await evaluate('location.hash = "#/promotions"');
    await waitFor('document.body.innerText.includes("Serving now: the built-in default")', 'promotions list');
    return 'signed in as hq_admin';
  });

  await step('HQ: upload 3 desktop clips, 3 phone clips and 3 posters (checked by content)', async () => {
    const files = CLIPS.flatMap((c) => [join(clipDir, `${c.name}.mp4`), join(clipDir, `${c.name}-m.mp4`), join(clipDir, `${c.name}.jpg`)]);
    const { root } = await send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[name=media]' });
    await send('DOM.setFileInputFiles', { nodeId, files });
    await waitFor('document.querySelectorAll(".hq-media").length === 9', 'nine uploads listed', 30000);
    const list = await evaluate('fetch("/api/hq/media", { credentials: "same-origin" }).then((r) => r.json()).then((b) => b.data.map((m) => [m.label, m.url]))');
    media = Object.fromEntries(list);
    const onDisk = (await import('node:fs')).readdirSync(mediaDir);
    if (onDisk.length !== 9 || !onDisk.every((f) => /^[a-f0-9]{32}\.(mp4|jpg)$/.test(f))) throw new Error(`media dir: ${onDisk}`);
    return Object.entries(media).map(([k, v]) => `${k}→${v.slice(7, 15)}…`).join(' ');
  });

  await step('HQ: create an active promotion in the editor; the live preview follows the typing', async () => {
    await evaluate('location.hash = "#/promotions/new"');
    await waitFor('!!document.querySelector("input[name=\'slides.2.poster\']") && !!document.querySelector(".hero-preview .hero-headline")', 'editor with preview');
    await fill('input[name=name]', 'E2E handover test');
    await fill('select[name=status]', 'active');
    await fill('input[name="overlay.eyebrow"]', 'E2E');
    await fill('input[name="overlay.headline"]', 'Three clips, no black frames');
    for (const [i, c] of CLIPS.entries()) {
      await fill(`input[name="slides.${i}.videoDesktop"]`, media[`${c.name}.mp4`]);
      await fill(`input[name="slides.${i}.videoMobile"]`, media[`${c.name}-m.mp4`]);
      await fill(`input[name="slides.${i}.poster"]`, media[`${c.name}.jpg`]);
    }
    await fill('input[name="settings.transitionMs"]', '600');
    await fill('input[name="settings.handoverAtMs"]', '900');
    await waitFor('document.querySelector(".hero-preview .hero-headline")?.textContent === "Three clips, no black frames"', 'preview shows the new headline', 5000);
    await waitFor('[...document.querySelectorAll(".hero-preview video")].some((v) => v.currentSrc.includes("/media/") && !v.paused)', 'preview plays the uploaded clip', 10000);
    const phoneSrc = await evaluate('document.querySelector(".hero-preview.is-phone .is-front video")?.getAttribute("src")');
    if (phoneSrc !== media['clip-1-m.mp4']) throw new Error(`phone preview uses ${phoneSrc}`);
    await shot('02-hq-editor');
    await click('Create promotion', 'main');
    await waitFor('/^#\\/promotions\\/[0-9a-f-]{36}$/.test(location.hash)', 'saved and reopened');
    promoId = (await evaluate('location.hash')).split('/').pop();
    const row = (await superDb.query('SELECT status, settings FROM promotions WHERE id = $1', [promoId])).rows[0];
    if (row.status !== 'active' || row.settings.handoverAtMs !== 900) throw new Error(J(row));
    const audit = (await superDb.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('hq.promotion_create', 'hq.media_upload')")).rows[0].n;
    return `promotion ${promoId.slice(0, 8)}, ${audit} audit events`;
  });

  let heroBox = null;
  await step('landing: the live promotion plays its videos (desktop 16:9 sources)', async () => {
    await goto('/site/index.html');
    await waitFor('document.getElementById("hero").heroPlayer?.state.mode === "video"', 'video mode');
    await waitFor('[...document.querySelectorAll(".hero-layer.is-front video.has-frame")].some((v) => !v.paused)', 'first clip playing', 15000);
    const s = await hero('({ headline: h.querySelector(".hero-headline").textContent, src: h.querySelector(".hero-layer.is-front video").getAttribute("src"), next: [...h.querySelectorAll(".hero-layer:not(.is-front) video")].map((v) => v.getAttribute("src") + " ready " + v.readyState) })');
    if (s.headline !== 'Three clips, no black frames' || s.src !== media['clip-1.mp4']) throw new Error(J(s));
    heroBox = await evaluate('(() => { const r = document.getElementById("hero").getBoundingClientRect(); return { x: r.right - 130, y: r.top + 30, width: 120, height: 160 }; })()');
    await shot('03-landing-video');
    return `playing ${s.src.slice(7, 15)}…; preloaded next: ${s.next.join(', ')}`;
  });

  await step('handover: composited frames sampled through 4 switches (incl. the loop back): no blank frame', async () => {
    const r = await watchHandovers(heroBox, clipColours, 10500);
    if (r.bad.length) throw new Error(`${r.bad.length} blank/foreign frames of ${r.frames}: ${J(r.bad.slice(0, 5))}`);
    // Order must follow 0 -> 1 -> 2 -> 0 ... starting wherever we came in.
    for (let i = 1; i < r.seq.length; i++) if (r.seq[i] !== (r.seq[i - 1] + 1) % 3) throw new Error(`out of order: ${r.seq}`);
    if (r.seq.length < 4 || !r.seq.slice(1).includes(0)) throw new Error(`too few switches or no loop: ${r.seq}`);
    return `${r.frames} frames (${r.screencastFrames} from the compositor, ~${r.perSecond}/s), clip order ${r.seq.map((k) => k + 1).join('→')}, 0 blank`;
  });

  await step('pause button: everything stops (no handover for > a clip length), then resumes', async () => {
    await evaluate('document.querySelector(".hero-pause").click()');
    const label = await evaluate('document.querySelector(".hero-pause").getAttribute("aria-label")');
    const at = await hero('p.state.index');
    const allPaused = await evaluate('[...document.querySelectorAll(".hero-video")].every((v) => v.paused)');
    if (label !== 'Play background video' || !allPaused) throw new Error(`${label} ${allPaused}`);
    await sleep(4000);
    if ((await hero('p.state.index')) !== at) throw new Error('moved while paused');
    await evaluate('document.querySelector(".hero-pause").click()');
    await waitFor(`document.getElementById("hero").heroPlayer.state.index !== ${at}`, 'moving again', 6000);
    return `held slide ${at + 1} for 4 s; label toggled; resumed`;
  });

  await step('dots: click and arrow keys jump to a clip', async () => {
    await evaluate('document.querySelectorAll(".hero-dot")[2].click()');
    await waitFor('document.getElementById("hero").heroPlayer.state.index === 2 && !document.getElementById("hero").heroPlayer.state.transitioning', 'slide 3');
    const cur = await evaluate('document.querySelectorAll(".hero-dot")[2].getAttribute("aria-current")');
    await evaluate('document.querySelectorAll(".hero-dot")[2].focus()');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await waitFor('document.getElementById("hero").heroPlayer.state.index === 0 && document.activeElement === document.querySelectorAll(".hero-dot")[0]', 'ArrowRight wraps to slide 1');
    const tab = await evaluate('[...document.querySelectorAll(".hero-dot, .hero-pause")].every((b) => b.tabIndex === 0 && b.getAttribute("aria-label"))');
    if (cur !== 'true' || !tab) throw new Error(`${cur} ${tab}`);
    return 'aria-current follows; keyboard reachable and labelled';
  });

  await step('off-screen: scrolling the hero away pauses the clips; back resumes', async () => {
    await evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await waitFor('document.getElementById("hero").heroPlayer.state.reasons.includes("offscreen") && [...document.querySelectorAll(".hero-video")].every((v) => v.paused)', 'paused off-screen', 5000);
    await evaluate('window.scrollTo(0, 0)');
    await waitFor('!document.getElementById("hero").heroPlayer.state.paused && [...document.querySelectorAll(".hero-layer.is-front .hero-video")].some((v) => !v.paused)', 'playing again', 5000);
    return 'IntersectionObserver pause/resume';
  });

  await step('HQ edit → public page: change the headline in HQ, the landing page shows it', async () => {
    await goto(`/hq/#/promotions/${promoId}`);
    await waitFor('!!document.querySelector("input[name=\'overlay.headline\']")', 'editor');
    await fill('input[name="overlay.headline"]', 'Edited in HQ a moment ago');
    await waitFor('document.querySelector(".hero-preview .hero-headline")?.textContent === "Edited in HQ a moment ago"', 'preview');
    await click('Save', 'main');
    await waitFor('document.body.innerText.includes("v2")', 'saved as v2');
    await goto('/site/index.html');
    await waitFor('document.querySelector(".hero-headline")?.textContent === "Edited in HQ a moment ago" && document.querySelector(".hero-copy").classList.contains("is-ready")', 'public headline updated', 8000);
    return 'public page shows the edit';
  });

  await step('reduced motion: posters only, slow crossfade, still no blank frame', async () => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await goto('/site/index.html');
    await waitFor('document.getElementById("hero").heroPlayer?.state.mode === "posters"', 'posters mode');
    const s = await hero('({ videos: h.querySelectorAll("video").length, poster: h.querySelector(".hero-layer.is-front img").getAttribute("src"), fade: h.style.getPropertyValue("--hero-fade"), transition: h.dataset.transition })');
    if (s.videos !== 0 || s.poster !== media['clip-1.jpg'] || s.fade !== '1600ms' || s.transition !== 'fade') throw new Error(J(s));
    const box = await evaluate('(() => { const r = document.getElementById("hero").getBoundingClientRect(); return { x: r.right - 130, y: r.top + 30, width: 120, height: 160 }; })()');
    const r = await watchHandovers(box, clipColours, 10500);
    if (r.bad.length) throw new Error(`${r.bad.length} blank frames: ${J(r.bad.slice(0, 3))}`);
    if (r.seq.length < 2) throw new Error(`no crossfade seen: ${r.seq}`);
    await shot('04-reduced-motion');
    await send('Emulation.setEmulatedMedia', { features: [] });
    return `no <video>, poster crossfade ${s.fade}, ${r.frames} frames, order ${r.seq.map((k) => k + 1).join('→')}, 0 blank`;
  });

  await step('Save-Data: posters only', async () => {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(Navigator.prototype, "connection", { get: () => ({ saveData: true, effectiveType: "4g", addEventListener() {} }) });' });
    await goto('/site/index.html');
    await waitFor('document.getElementById("hero").heroPlayer?.state.mode === "posters"', 'posters mode');
    const videos = await evaluate('document.querySelectorAll("#hero video").length');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    if (videos) throw new Error(`${videos} videos`);
    return 'no video elements, no video bytes requested';
  });

  await step('phone width (390 × 844): 9:16 sources, text fits, no sideways scroll', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await goto('/site/index.html');
    await waitFor('[...document.querySelectorAll(".hero-layer.is-front video.has-frame")].some((v) => !v.paused)', 'phone clip playing', 15000);
    const s = await evaluate(`(() => {
      const copy = document.querySelector(".hero-copy").getBoundingClientRect();
      const hero = document.getElementById("hero").getBoundingClientRect();
      return { src: document.querySelector(".hero-layer.is-front video").getAttribute("src"), scrollW: document.documentElement.scrollWidth, w: innerWidth,
        copyFits: copy.left >= 0 && copy.right <= innerWidth && copy.bottom <= hero.bottom, controls: getComputedStyle(document.querySelector(".hero-controls")).top,
        cta: document.querySelector(".hero-primary").getBoundingClientRect().height };
    })()`);
    if (s.src !== media['clip-1-m.mp4'] || s.scrollW > s.w || !s.copyFits || s.cta < 44) throw new Error(J(s));
    await shot('05-phone');
    await evaluate('window.scrollTo(0, 900)');
    await sleep(600);
    await shot('06-phone-below');
    const wide = await evaluate('[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className || e.tagName).slice(0, 5)');
    if (wide.length) throw new Error(`overflowing: ${wide}`);
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    return `src ${s.src.slice(7, 15)}… (phone cut), page ${s.scrollW}px wide in ${s.w}px, CTA ${s.cta}px tall`;
  });

  await step('pricing, status and sign-up pages still load with the shared CSS; Sign in stays on this host', async () => {
    const out = [];
    for (const p of ['/site/pricing.html', '/site/status.html', '/site/signup.html?plan=pro']) {
      await goto(p);
      await waitFor('document.querySelectorAll("[data-brand]").length && [...document.querySelectorAll("[data-brand]")].every((e) => e.textContent === "Fishtape")', `${p} scripts ran`);
      const href = await evaluate('document.querySelector("a[data-app-link]")?.href');
      if (!href?.startsWith(ORIGIN)) throw new Error(`${p}: app link ${href}`);
      out.push(`${p.split('/').pop()} → ${new URL(href).pathname}${new URL(href).hash}`);
    }
    return out.join('; ');
  });

  await step('console: no errors or warnings on the public pages (CSP included)', async () => {
    const pub = consoleLines.filter((l) => l.page.startsWith('/site/'));
    if (pub.length) throw new Error(J(pub.slice(0, 8)));
    const hq = consoleLines.filter((l) => !l.page.startsWith('/site/'));
    return `public pages clean; HQ: ${hq.length ? hq.map((l) => l.text.slice(0, 90)).join(' | ') : 'clean'}`;
  });
} catch {
  exitCode = 1;
} finally {
  writeFileSync(join(SCRATCH, 'landing-e2e-results.json'), J({ results, console: consoleLines }, null, 2));
  console.log('\n' + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)\n      ${r.detail}`).join('\n'));
  console.log(`\nscreenshots and results in ${SCRATCH}`);
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await api.close();
  await db.close();
  await superDb.end();
  web.close();
  await pgServer.stop();
  process.exit(exitCode);
}
