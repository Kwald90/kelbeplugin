// Browser smoke test for estimate editing, recorded approval and repeat conversion.
// Run: node electrical-app/tests/e2e/estimate-experience.e2e.mjs
// Requires Chrome (CHROME_PATH can override its Windows default); no API or npm packages.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const app = fileURLToPath(new URL('../../', import.meta.url));
const script = `
import estimates from '/js/modules/estimates.js';
import * as ui from '/js/ui.js';
import { newDocTax } from '/js/lib/tax.js';
const output = document.querySelector('pre');
try {
  const ok = (value, message) => { if (!value) throw Error(message); checks.push(message); };
  const checks = [];
  const settings = { currency: 'CAD', companyName: 'Test Electric', labourRateCents: 9500, tax: { mode: 'canada', province: 'AB', treatment: 'standard' } };
  const rows = { estimates: [{ id: 'e1', number: 'E-001', title: 'Panel work', clientId: 'c1', status: 'draft', validUntil: '2026-11-20', lines: [{ description: 'Panel', kind: 'material', qty: 1, unitCents: 10000 }], labourRateCents: 9500, markupPct: 0, notes: '', ...newDocTax(settings) }], clients: [{ id: 'c1', name: 'Test Customer', address: '123 Test Street' }], jobs: [] };
  const listeners = new Map();
  let writes = 0;
  const emit = (c, record) => { for (const cb of listeners.get(c) || []) cb({ type: 'update', record: structuredClone(record) }); };
  const store = {
    settings: () => settings,
    list: (c, pred = () => true) => structuredClone((rows[c] || []).filter(pred)),
    get: (c, id) => structuredClone((rows[c] || []).find(r => r.id === id) || null),
    update: (c, id, patch) => { writes++; const rec = rows[c].find(r => r.id === id); Object.assign(rec, structuredClone(patch)); emit(c, rec); return structuredClone(rec); },
    add: (c, fields) => { writes++; const rec = { ...structuredClone(fields), id: c + (rows[c]?.length || 0) }; (rows[c] ||= []).push(rec); emit(c, rec); return structuredClone(rec); },
    nextNumber: c => c + '-1',
    on: (c, cb) => { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return () => listeners.get(c).delete(cb); },
    meta: () => null,
  };
  let route = '';
  const root = document.querySelector('main');
  const ctx = { params: ['e1'], query: {}, store, ui, nav: to => { route = to; }, on: () => true, auth: { synced: false, can: () => true, role: () => 'owner' } };
  let cleanup;
  const render = (readOnly = false) => { cleanup?.(); root.replaceChildren(); cleanup = estimates.render(root, { ...ctx, readOnly }); };
  const button = (text, scope = root) => [...scope.querySelectorAll('button, a')].find(el => el.textContent.trim() === text);
  render();
  ok(root.querySelector('.estimate-pricing')?.open === false, 'advanced pricing starts collapsed');
  ok(root.textContent.indexOf('Scope & line items') < root.textContent.indexOf('Pricing & tax settings'), 'scope precedes advanced pricing');
  root.querySelector('.estimate-pricing').open = true;
  const rate = root.querySelector('[name=labourRateCents]');
  rate.value = '110.00'; rate.dispatchEvent(new Event('input', { bubbles: true }));
  const markup = root.querySelector('[name=markupPct]');
  markup.value = '10'; markup.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 500));
  ok(rows.estimates[0].labourRateCents === 11000 && rows.estimates[0].markupPct === 10, 'pricing disclosure changes autosave as cents and percentage');
  root.querySelector('.estimate-pricing').open = false;
  const title = root.querySelector('[name=title]');
  title.value = 'Panel replacement'; title.dispatchEvent(new Event('input', { bubbles: true }));
  button('Preview quote').click();
  ok(store.get('estimates', 'e1').title === 'Panel replacement', 'preview flushes pending edits');
  ok(document.querySelector('.doc-preview')?.textContent.includes('Panel replacement'), 'customer preview contains saved scope');
  button('Close', document).click();
  button('Mark sent').click();
  ok(rows.estimates[0].status === 'sent', 'mark sent persists status');
  button('Record approval').click();
  ok(rows.estimates[0].status === 'sent', 'opening approval dialog does not accept quote');
  ok(document.querySelector('[role=dialog]')?.textContent.includes('does not capture a customer signature'), 'approval dialog describes external approval truthfully');
  button('Cancel', document).click();
  ok(rows.estimates[0].status === 'sent', 'cancelling approval preserves sent state');
  button('Record approval').click();
  button('Record approval', document.querySelector('[role=dialog]')).click();
  ok(rows.estimates[0].status === 'accepted', 'confirming records accepted status');
  const create = button('Create job'); create.click(); create.click();
  ok(rows.jobs.length === 1 && rows.estimates[0].jobId === rows.jobs[0].id, 'repeated conversion clicks link a single job');
  ok(route.endsWith('?tab=schedule'), 'job conversion opens scheduling');
  render(); button('Open job').click();
  ok(rows.jobs.length === 1, 'reopening does not create a duplicate job');
  rows.estimates[0].jobId = null; render(); button('Open job').click();
  ok(rows.jobs.length === 1, 'existing conversion is found when estimate link is missing');
  rows.estimates[0].taxTreatment = 'none'; rows.estimates[0].taxes = []; render();
  ok(root.querySelector('[data-no-tax]').hidden === false && !root.querySelector('.estimate-pricing').contains(root.querySelector('[data-no-tax]')), 'no-tax reason remains visible outside disclosure');
  render(true); const before = writes;
  ok([...root.querySelectorAll('input, select, textarea')].every(el => el.disabled || el.readOnly), 'view-only quote disables editing');
  ok(!button('Record approval') && !button('Create invoice') && !button('Duplicate'), 'view-only quote omits mutation actions');
  button('Preview quote').click(); button('Close', document).click();
  ok(writes === before, 'view-only preview causes no store writes');
  cleanup?.(); root.replaceChildren();
  estimates.render(root, { ...ctx, params: ['new'], readOnly: true });
  ok(writes === before && root.textContent.includes('view only'), 'view-only new route does not create a record');
  output.textContent = JSON.stringify({ passed: checks.length, checks });
  output.dataset.result = 'pass';
} catch (error) { output.textContent = error.stack; output.dataset.result = 'fail'; }
`;
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><main></main><pre></pre><script type="module" src="/test.mjs"></script>'); return; }
  if (req.url === '/test.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return; }
  const path = resolve(app, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(resolve(app) + '\\') && !path.startsWith(resolve(app) + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/plain'); res.end(readFileSync(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = mkdtempSync(join(tmpdir(), 'fishtape-estimate-test-'));
try {
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--user-data-dir=' + profile, '--virtual-time-budget=5000', '--dump-dom', 'http://127.0.0.1:' + server.address().port], { windowsHide: true });
  let output = '', errors = '';
  browser.stdout.on('data', b => { output += b; });
  browser.stderr.on('data', b => { errors += b; });
  const timer = setTimeout(() => browser.kill(), 25000);
  await new Promise((resolve, reject) => { browser.on('error', reject); browser.on('exit', resolve); });
  clearTimeout(timer);
  assert.ok(/data-result="pass"/.test(output), output.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] || errors);
  console.log(output.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] || 'Estimate experience passed.');
} finally {
  server.closeAllConnections(); server.close();
  // mkdtempSync created this dedicated directory under the OS temporary directory.
  if (resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
