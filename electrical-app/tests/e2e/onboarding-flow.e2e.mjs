// Browser smoke for progressive onboarding using real DOM controls and a local settings store.
// Run: node electrical-app/tests/e2e/onboarding-flow.e2e.mjs
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
import onboarding, { onboardingCard } from '/js/modules/onboarding.js';
import { DEFAULT_SETTINGS } from '/js/store.js';
import * as UI from '/js/ui.js';
const output = document.querySelector('pre');
try {
  const checks = [];
  const ok = (value, message) => { if (!value) throw Error(message); checks.push(message); };
  const settings = structuredClone(DEFAULT_SETTINGS);
  let count = 0, writes = 0;
  const store = {
    settings: () => settings, count: c => c === 'estimates' ? count : 0,
    meta: () => null, on: () => () => {},
    saveSettings: patch => { writes++; Object.assign(settings, patch); },
  };
  const ui = { ...UI, confirmDialog: async () => true };
  const auth = { synced: false, isAdmin: () => true, can: () => true };
  const root = document.querySelector('main');
  let cleanup;
  const render = (query = {}) => { cleanup?.(); root.replaceChildren(); cleanup = onboarding.render(root, { store, ui, auth, query }); };
  const button = (text, scope = root) => [...scope.querySelectorAll('button,a')].find(el => el.textContent.trim() === text);
  const fill = (name, value) => { const el = root.querySelector('.ob-step.open [name=' + name + ']'); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  render(); await Promise.resolve();
  ok(root.querySelector('[data-step=company]').classList.contains('open'), 'company is the first open essential');
  ok(!root.querySelector('.ob-later').open, 'later setup starts collapsed');
  ok(root.querySelector('.ob-quote-entry a')?.textContent.includes('Start a draft quote'), 'unfinished essentials offer a clearly labelled draft');
  ok(writes === 0, 'opening setup does not silently change progress');
  fill('name', 'Test Electrical'); fill('phone', '403-555-0100'); fill('gstHstNo', '123456789 RT0001');
  button('Save', root.querySelector('.ob-step.open')).click();
  ok(root.querySelector('[data-step=company]').classList.contains('done'), 'company details persist and verify');
  ok(root.querySelector('[data-step=province]').classList.contains('open'), 'province follows company');
  button('Confirm', root.querySelector('.ob-step.open')).click();
  ok(settings.onboarding.provinceAt && root.querySelector('[data-step=rates]').classList.contains('open'), 'confirmed province advances directly to rates');
  fill('labourRateCents', '110'); fill('markupPct', '12');
  button('Confirm', root.querySelector('.ob-step.open')).click();
  ok(settings.labourRateCents === 11000 && settings.markupPct === 12 && settings.onboarding.ratesAt, 'rates save in existing fields and units');
  ok(root.querySelector('.ob-start').textContent.includes('3 of 3 essentials verified'), 'essentials readiness is explicit');
  ok(root.querySelector('.ob-start').textContent.includes('3 of 9 setup steps completed'), 'essentials do not imply all setup is complete');
  ok(root.querySelector('.ob-quote-entry a')?.textContent.includes('Create first quote'), 'verified essentials prioritize first quote without a price book');
  ok(root.querySelector('.ob-later [data-step=pricebook]'), 'price book remains accessible under later setup');
  root.querySelector('[data-step=company] .ob-step-head').click();
  ok(root.querySelector('.ob-step.open [name=gstHstNo]')?.value === '123456789 RT0001', 'completed essentials can be reopened for review');
  render({ step: 'crew' });
  ok(root.querySelector('.ob-later').open && root.querySelector('[data-step=crew]').classList.contains('open'), 'direct later-step link expands its section');
  button('Skip this step', root.querySelector('.ob-step.open')).click();
  ok(settings.onboarding.skipped.crew === true, 'skip marker persists unchanged');
  render({ step: 'crew' }); button('Undo skip', root.querySelector('.ob-step.open')).click();
  ok(!settings.onboarding.skipped.crew, 'undo skip clears only that marker');
  settings.onboarding.provinceAt = null; settings.onboarding.skipped.province = true; render();
  ok(root.querySelector('.ob-start').textContent.includes('2 of 3 essentials verified') && root.querySelector('.ob-start').textContent.includes('Skipped essentials still need review'), 'skipped essentials do not claim readiness');
  settings.modules.estimates = false; render();
  ok(!root.querySelector('.ob-quote-entry a') && root.textContent.includes('Estimates are turned off'), 'disabled estimates have explanation and no quote link');
  settings.modules.estimates = true; count = 2; render();
  ok(root.querySelector('.ob-quote-entry a')?.getAttribute('href') === '#/estimates', 'existing estimates open the list');
  button('Hide checklist').click(); await Promise.resolve();
  ok(settings.onboarding.dismissedAt && onboardingCard({ store, ui, auth }) === null, 'dismissed checklist stays hidden on the dashboard');
  render(); button('Show on the dashboard').click();
  ok(settings.onboarding.dismissedAt === null && settings.onboarding.skipped.province, 'restore preserves skipped and completed setup');
  ok(root.scrollWidth <= root.clientWidth + 1, 'setup fits a narrow container without horizontal overflow');
  cleanup?.();
  output.textContent = JSON.stringify({ passed: checks.length, checks }); output.dataset.result = 'pass';
} catch (error) { output.textContent = error.stack; output.dataset.result = 'fail'; }
`;

const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/css/tokens.css><link rel=stylesheet href=/css/app.css><link rel=stylesheet href=/css/onboarding.css><main style="max-width:390px;width:100%"></main><pre hidden></pre><script type="module" src="/test.mjs"></script>'); return; }
  if (req.url === '/test.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return; }
  const path = resolve(app, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(resolve(app) + '\\') && !path.startsWith(resolve(app) + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/plain'); res.end(readFileSync(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const profile = mkdtempSync(join(tmpdir(), 'fishtape-onboarding-test-'));
try {
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--user-data-dir=' + profile, '--virtual-time-budget=5000', '--dump-dom', 'http://127.0.0.1:' + server.address().port], { windowsHide: true });
  let output = '', errors = '';
  browser.stdout.on('data', b => { output += b; });
  browser.stderr.on('data', b => { errors += b; });
  const timer = setTimeout(() => browser.kill(), 25000);
  await new Promise((resolve, reject) => { browser.on('error', reject); browser.on('exit', resolve); });
  clearTimeout(timer);
  assert.ok(/data-result="pass"/.test(output), output.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] || errors);
  console.log(output.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] || 'Onboarding flow passed.');
} finally {
  server.closeAllConnections(); server.close();
  // mkdtempSync created this dedicated directory under the OS temporary directory.
  if (resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
