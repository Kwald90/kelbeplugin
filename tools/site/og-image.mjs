#!/usr/bin/env node
// Draws the Open Graph / Twitter card image (site/img/og/fishtape-og.png, 1200x630) with headless
// Chrome: the brand mark, name and one line, in the site's colours. Re-run after a rebrand.
//   node tools/site/og-image.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BRAND } from '../../electrical-app/js/brand.js';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../site/img/og/fishtape-og.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:radial-gradient(120% 90% at 85% 20%,#2a2d33,#121315);color:#fff;font-family:Inter,"Segoe UI",system-ui,sans-serif;position:relative;overflow:hidden}
.wrap{position:absolute;inset:0;padding:80px 88px;display:flex;flex-direction:column;justify-content:center;gap:28px}
.brand{display:flex;align-items:center;gap:22px;font-size:64px;font-weight:800;letter-spacing:-0.02em}
.mark{width:92px;height:92px;border-radius:26px;background:#f5b301;color:#1c1b19;display:grid;place-items:center;font-size:54px}
h1{font-size:58px;line-height:1.08;font-weight:800;letter-spacing:-0.025em;max-width:900px}
p{font-size:30px;color:rgba(255,255,255,.82);max-width:900px}
.tag{color:#f5b301;font-weight:700;font-size:24px;letter-spacing:.08em;text-transform:uppercase}
.wire{position:absolute;right:-60px;bottom:-60px;width:520px;height:520px;border:18px solid rgba(245,179,1,.18);border-radius:50%}
.wire2{position:absolute;right:60px;bottom:60px;width:280px;height:280px;border:12px solid rgba(245,179,1,.28);border-radius:50%}
</style></head><body><div class="wire"></div><div class="wire2"></div><div class="wrap">
<div class="brand"><span class="mark">⚡</span>${BRAND.name}</div>
<p class="tag">CEC 2024 built in</p>
<h1>Software for Canadian electrical contractors</h1>
<p>Quotes, jobs, drawings, crew time and invoices in one app.</p>
</div></body></html>`;

const profile = mkdtempSync(join(tmpdir(), 'fishtape-og-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]); });
  setTimeout(() => rej(new Error('Chrome did not start')), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(page).toString('base64')}` }, sessionId);
await new Promise((r) => setTimeout(r, 1200));
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(`wrote ${OUT}`);
ws.close();
chrome.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(profile, { recursive: true, force: true }); } catch { /* still closing */ }
