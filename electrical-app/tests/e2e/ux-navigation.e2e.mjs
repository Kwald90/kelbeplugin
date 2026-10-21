// Demo-only navigation smoke; no API, credentials or database dependencies.
// node electrical-app/tests/e2e/ux-navigation.e2e.mjs [artifact directory]
// CHROME_PATH can override the local Chrome binary. Screenshots stay outside the repo by default.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-ux-nav-'));
mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"not_signed_in"}'); }
  const file = resolve(app, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(app + sep)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = join(artifacts, 'chrome-profile');
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* starting */ } }
  assert.ok(port, 'Chrome starts');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); } throw new Error(`Timed out: ${expression}`); };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const shot = async (name) => { await sleep(250); const { data } = await page('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(data, 'base64')); };
  await page('Runtime.enable'); await page('Page.enable');
  await page('Network.enable'); await page('Network.setBypassServiceWorker', { bypass: true });
  await page('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await page('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('ft.mode','demo');localStorage.setItem('ft.units','metric');" });
  await page('Page.navigate', { url: origin });
  await wait("!!document.querySelector('.rail-destinations [data-mod=jobs]')");
  assert.equal(await evaluate("document.querySelector('.rail [data-mod=clients] .nav-label').textContent"), 'Customers');
  assert.ok(await evaluate("document.querySelector('.rail').getBoundingClientRect().width > 200"));
  await shot('desktop-expanded');
  await click('.rail-collapse');
  assert.ok(await evaluate("document.querySelector('.rail').getBoundingClientRect().width < 80"));
  await page('Page.reload');
  await wait("!!document.querySelector('.app.nav-compact')");
  await shot('desktop-compact');
  await click('.rail-collapse');
  await page('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("kelbe.nav('estimates/' + kelbe.store.list('estimates').find(e => e.lines?.length).id)");
  await wait("!!document.querySelector('.doc-layout')");
  assert.ok(await evaluate("document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth"), '1100px document fits beside labelled sidebar');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc-side')).position"), 'static');
  await shot('desktop-medium-estimate');
  await page('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate("document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth"), 'populated desktop estimate fits');
  await shot('desktop-estimate');
  await evaluate("kelbe.nav('dashboard')");
  await wait("location.hash === '#/dashboard'");
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-primary [data-mod]')].map(a=>a.dataset.mod)"), ['dashboard', 'clients', 'jobs', 'invoices']);
  assert.ok(await evaluate("[...document.querySelectorAll('.mobile-primary .rail-btn')].every(a=>a.getBoundingClientRect().height>=44 && a.getBoundingClientRect().width>=44)"));
  await shot('phone-owner');
  await evaluate("kelbe.nav('estimates/' + kelbe.store.list('estimates').find(e => e.lines?.length).id)");
  await wait("!!document.querySelector('.doc-layout')");
  assert.ok(await evaluate("document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth"), 'phone estimate has no horizontal overflow');
  await shot('phone-estimate');
  await evaluate("kelbe.nav('dashboard')");
  await wait("location.hash === '#/dashboard'");
  await click('.nav-more');
  await wait("!!document.querySelector('.more-navigation')");
  await wait("document.activeElement === document.querySelector('.more-navigation a[href]')");
  assert.equal(await evaluate("document.querySelectorAll('.more-navigation [data-mod]').length"), await evaluate("kelbe.MODULES.filter(m=>!m.hidden&&kelbe.auth.can(m.perm)&&kelbe.moduleEnabled(m.id)).length"));
  await shot('phone-more');
  await click('.more-navigation [data-mod=calcs]');
  await wait("location.hash === '#/calcs' && !document.querySelector('.more-navigation')");
  assert.equal(await evaluate("document.querySelector('.nav-more').getAttribute('aria-current')"), 'page');
  await click('.nav-more');
  await evaluate("[...document.querySelectorAll('.more-navigation button')].find(b=>b.textContent==='Switch demo user').click()");
  await evaluate("[...document.querySelectorAll('.dialog .list-row')].find(r=>r.textContent.includes('Priya Shah')).click()");
  await wait("kelbe.auth.role()==='electrician'");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-primary [data-mod]')].map(a=>a.dataset.mod)"), ['today', 'jobs', 'time', 'drawings']);
  await click('.mobile-primary [data-mod=today]');
  await wait("location.hash === '#/today'");
  await shot('phone-field');
  await click('.nav-more');
  assert.equal(await evaluate("!!document.querySelector('.more-navigation [data-mod=invoices]')"), false);
  // Exercise a settings sync update: the shell must refresh and dismiss stale More links.
  await evaluate("kelbe.store.saveSettings({modules: {drawings: false}})");
  await wait("!document.querySelector('.more-navigation') && !document.querySelector('.rail [data-mod=drawings]')");
  await click('.nav-more');
  assert.equal(await evaluate("!!document.querySelector('.more-navigation [data-mod=drawings]')"), false);
  await evaluate("kelbe.store.saveSettings({modules: null})");
  await wait("!!document.querySelector('.mobile-primary [data-mod=drawings]')");
  await click('.mobile-primary [data-mod=drawings]');
  await wait("location.hash === '#/drawings'");
  const drawing = await evaluate("kelbe.store.list('drawings')[0]?.id");
  assert.ok(drawing, 'demo contains a drawing');
  await evaluate(`kelbe.nav('drawings/${drawing}')`);
  await wait("document.body.classList.contains('canvas-open')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.rail')).display"), 'none');
  await shot('phone-canvas');
  await evaluate("kelbe.nav('today')");
  await wait("!document.body.classList.contains('canvas-open')");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.rail')).display"), 'none');
  assert.ok(!await evaluate("document.querySelector('meta[name=viewport]').content.includes('user-scalable=no')"));
  assert.deepEqual(errors, [], 'no JavaScript runtime errors');
  console.log(JSON.stringify({ passed: true, artifacts, checks: ['desktop labels and collapse persistence', 'mobile role destinations and 44px targets', 'all permitted modules reachable through More', 'More active state', 'demo role switch', 'disabled module update', 'canvas shell restoration', 'zoom enabled', 'runtime errors'] }, null, 2));
} finally {
  ws?.close(); chrome.kill(); server.closeAllConnections(); server.close();
}

