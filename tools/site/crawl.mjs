#!/usr/bin/env node
// Click-through of the public site in headless Chrome, against tools/site/serve.mjs (production
// routing, production CSP, the public API mocked).
//
//   node tools/site/crawl.mjs [--port 8091] [--out <dir for screenshots>]
//
// 1. Reads site/sitemap.xml and fetches every page; every internal link on every page (clean
//    production URLs from the HTML, and the /site/*.html URLs site.js points them at off the
//    marketing hosts) must answer 200.
// 2. Opens every page in Chrome at 1280 px and at 390 px (phone) and fails on: sideways scroll,
//    console errors or warnings (CSP violations included), uncaught exceptions, failed requests,
//    layout shift over 0.05, images without width/height, and images much larger than shown.
// 3. Checks the phone menu, the services "Talk to us" form and the status page's uptime bars.
// CHROME_PATH overrides the Chrome binary. Exit 1 on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSiteServer } from './serve.mjs';

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 8091));
const OUT = arg('--out', '');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const failures = [];
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`FAIL  ${where}: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP ----
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }),
    on: (fn) => listeners.add(fn),
    close: () => ws.close(),
  };
}

async function main() {
  const server = createSiteServer({ mock: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = mkdtempSync(join(tmpdir(), 'fishtape-crawl-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]); });
    setTimeout(() => rej(new Error('Chrome did not start')), 20000);
  });
  const c = await cdp(wsUrl);
  try {
    await run(c);
  } finally {
    c.close();
    chrome.kill();
    server.close();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ }
  }
  console.log(`\n${failures.length ? `${failures.length} failure(s)` : 'all checks passed'}`);
  process.exit(failures.length ? 1 : 0);
}

async function httpStatus(path) {
  try { return (await fetch(BASE + path, { redirect: 'manual' })).status; } catch { return 0; }
}

function linksIn(html) {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

async function run(c) {
  // ---- 1. sitemap + links over HTTP ----
  const sitemap = readFileSync(join(ROOT, 'site/sitemap.xml'), 'utf8');
  const pages = [...sitemap.matchAll(/<loc>https:\/\/fishtapehq\.com([^<]*)<\/loc>/g)].map((m) => m[1]);
  const extra = ['/terms', '/privacy'];
  const all = [...pages, ...extra];
  console.log(`sitemap: ${pages.length} pages (+ ${extra.length} not indexed)`);
  const links = new Set();
  for (const p of all) {
    const res = await fetch(BASE + p);
    if (res.status !== 200) { fail(p, `answered ${res.status}`); continue; }
    for (const href of linksIn(await res.text())) if (href.startsWith('/') && !href.startsWith('//')) links.add(href.split('#')[0] || '/');
  }
  for (const p of ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt']) links.add(p);
  let ok = 0;
  for (const l of links) { const s = await httpStatus(l); if (s === 200) ok++; else fail(`link ${l}`, `answered ${s}`); }
  console.log(`links (clean URLs): ${ok}/${links.size} answered 200`);
  for (const p of ['/api/v1/me', '/hq/', '/.env', '/site/../deploy/production/.env', '/server/package.json', '/docs/BUILD-PLAN.md', '/site/.env', '/features/../../.env', '/for/ON', '/features/nope']) {
    const s = await httpStatus(p);
    if (s === 200) fail(`sensitive ${p}`, 'answered 200');
  }

  // ---- 2. Chrome ----
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => c.send(m, p, s);
  const events = [];
  c.on((msg) => { if (msg.sessionId === s) events.push(msg); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__cls=0;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:"layout-shift",buffered:true})}catch(e){}' });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const domLinks = new Set();

  async function visit(path, width) {
    const phone = width < 600;
    await send('Emulation.setDeviceMetricsOverride', { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    events.length = 0;
    const loaded = new Promise((r) => { const t = setInterval(() => { if (events.some((e) => e.method === 'Page.loadEventFired')) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 15000); });
    await send('Page.navigate', { url: BASE + path });
    await loaded;
    await sleep(700);
    // Scroll through the page so lazy images load, then back to the top.
    await evaluate('(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){scrollTo(0,y);await new Promise(r=>setTimeout(r,60));}scrollTo(0,0);await new Promise(r=>setTimeout(r,400));})()');
    const where = `${path} @${width}`;
    const r = await evaluate(`(() => {
      const de = document.documentElement;
      // The hero's poster layers are drawn by hero.js (object-fit cover, sized by the hero), not content images.
      const imgs = [...document.images].filter((i) => !i.closest('.hero-stage')).map((i) => ({ src: i.currentSrc || i.src, w: i.clientWidth, nw: i.naturalWidth, attrs: i.hasAttribute('width') && i.hasAttribute('height'), complete: i.complete, visible: i.getClientRects().length > 0 }));
      const res = performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'img').map((e) => ({ url: e.name, bytes: e.encodedBodySize }));
      const wide = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && e.closest('.site-hp') == null && e.closest('.sr-only') == null && !e.closest('.site-skip'); }).slice(0, 3).map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''));
      return { scrollW: de.scrollWidth, innerW: innerWidth, cls: window.__cls, imgs, res, wide, links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), h1: [...document.querySelectorAll('h1')].filter((h) => h.getClientRects().length).length, title: document.title };
    })()`);
    if (r.scrollW > r.innerW + 1) fail(where, `sideways scroll (${r.scrollW} > ${r.innerW}): ${r.wide.join(', ')}`);
    if (r.cls > 0.05) fail(where, `layout shift ${r.cls.toFixed(3)}`);
    if (r.h1 !== 1) fail(where, `${r.h1} h1 elements`);
    for (const i of r.imgs) {
      if (!i.attrs) fail(where, `image without width/height: ${i.src}`);
      if (i.visible && i.complete && i.nw === 0) fail(where, `image did not load: ${i.src}`);
      if (i.visible && i.w > 0 && !/\.svg$/.test(i.src) && i.nw > i.w * (phone ? 2 : 1) * 2.2 && i.nw > 800) fail(where, `image ${i.src.split('/').pop()} is ${i.nw}px wide, shown at ${i.w}px`);
    }
    for (const e of r.res) if (e.bytes > 250_000) fail(where, `image ${e.url.split('/').pop()} is ${Math.round(e.bytes / 1024)} KB`);
    for (const l of r.links) if (l.startsWith('/') && !l.startsWith('//')) domLinks.add(l.split('#')[0] || '/');
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') fail(where, `exception: ${e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text}`);
      if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(e.params.type)) fail(where, `console.${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) fail(where, `${e.params.entry.source} ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`);
      if (e.method === 'Network.loadingFailed' && !e.params.canceled) fail(where, `request failed: ${e.params.errorText}`);
      if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) fail(where, `${e.params.response.status} ${e.params.response.url}`);
    }
    if (OUT) {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false });
      writeFileSync(join(OUT, `${(path.replace(/\//g, '_') || '_') || 'home'}-${width}.jpg`), Buffer.from(shot.data, 'base64'));
    }
    return r;
  }

  if (OUT) mkdirSync(OUT, { recursive: true });
  let visits = 0;
  for (const p of all) {
    for (const w of [1280, 390]) { await visit(p, w); visits++; }
  }
  console.log(`chrome: ${visits} page views checked (1280 and 390 px)`);

  // Links as site.js rewrites them off the marketing hosts (/site/*.html, as on staging).
  let ok2 = 0;
  for (const l of domLinks) { const st = await httpStatus(l); if (st === 200) ok2++; else fail(`dom link ${l}`, `answered ${st}`); }
  console.log(`links after site.js (staging-style /site/ paths): ${ok2}/${domLinks.size} answered 200`);

  // ---- 3. interactions ----
  await visit('/features', 390);
  const menu = await evaluate(`(async () => { document.querySelector('.site-menu summary').click(); await new Promise(r => setTimeout(r, 100));
    const p = document.querySelector('.site-menu-panel').getBoundingClientRect();
    const links = [...document.querySelectorAll('.site-menu-panel a')].map(a => a.textContent.trim());
    return { open: document.querySelector('.site-menu').open, inside: p.left >= 0 && p.right <= innerWidth + 1, links, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }; })()`);
  if (!menu.open || !menu.inside || menu.scrollW > menu.innerW + 1) fail('phone menu', JSON.stringify(menu));
  else if (menu.links.join('|') !== 'Features|Pricing|Services|About|Status|Sign in') fail('phone menu', `links ${menu.links.join(', ')}`);
  else console.log('phone menu: opens inside the screen with every link');

  await visit('/services', 1280);
  const form = await evaluate(`(async () => {
    document.querySelector('[data-service-pick="data-import"]').click();
    await new Promise(r => setTimeout(r, 300));
    const f = document.querySelector('form[data-lead-form]');
    const picked = f.querySelector('[name=service]').value;
    f.querySelector('[name=name]').value = 'Test Person'; f.querySelector('[name=email]').value = 'test@example.com'; f.querySelector('[name=company]').value = 'Test Electric';
    f.querySelector('button[type=submit]').click();
    await new Promise(r => setTimeout(r, 600));
    return { picked, formHidden: f.hidden, done: !document.getElementById(f.dataset.done).hidden };
  })()`);
  if (form.picked !== 'data-import' || !form.formHidden || !form.done) fail('services form', JSON.stringify(form)); else console.log('services form: picks the service and shows the thank-you');

  await visit('/status', 1280);
  const st = await evaluate(`({ days: document.querySelectorAll('.st-day:not(.st-legend .st-day)').length, rows: document.querySelectorAll('#components > li').length, upcoming: !document.getElementById('upcoming-section').hidden, recent: document.querySelectorAll('#notices-recent .st-notice').length, overall: document.getElementById('overall-title').textContent })`);
  if (st.rows !== 6 || st.days !== 540 || !st.upcoming || st.recent !== 1 || st.overall !== 'All systems operational') fail('status page', JSON.stringify(st));
  else console.log('status page: 6 components, 90-day bars, notices and the overall state');
}

main().catch((e) => { console.error(e); process.exit(1); });
