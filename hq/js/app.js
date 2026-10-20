// Fishtape HQ console: boot, sign-in gate (HQ staff + MFA), rail and hash router.
// Reuses the app's UI kit (/js/ui.js) and design tokens; served by nginx at /hq/.
import * as ui from '/js/ui.js';
import { BRAND } from '/js/brand.js';
import { api, onAuthProblem, post } from './api.js';
import { showSignIn } from './signin.js';

const { h, icon } = ui;

const PAGES = [
  { id: 'overview', title: 'Overview', icon: 'home', load: () => import('./pages/overview.js') },
  { id: 'tenants', title: 'Companies', icon: 'users', load: () => import('./pages/tenants.js') },
  { id: 'health', title: 'Developer health', icon: 'activity', load: () => import('./pages/health.js') },
  { id: 'compliance', title: 'Compliance & security', icon: 'shield-check', load: () => import('./pages/compliance.js') },
  { id: 'billing', title: 'Billing', icon: 'dollar', load: () => import('./pages/billing.js') },
  { id: 'leads', title: 'Leads', icon: 'funnel', load: () => import('./pages/leads.js') },
  { id: 'mail', title: 'Mail', icon: 'mail', load: () => import('./pages/mail.js') },
  { id: 'flags', title: 'Feature flags', icon: 'sliders', load: () => import('./pages/flags.js') },
];

let me = null;
let shell = null, main = null, rail = null, cleanup = null, routeSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { id: parts[0] || 'overview', params: parts.slice(1) };
}

export function nav(path) {
  const next = '#/' + path.replace(/^#?\//, '');
  if (location.hash === next) route(); else location.hash = next;
}

async function route() {
  if (!me) return;
  const seq = ++routeSeq;
  const { id, params } = parseHash();
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  for (const a of rail.querySelectorAll('[data-page]')) {
    if (a.dataset.page === page.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${page.title} · ${BRAND.name} HQ`;
  ui.clear(main);
  main.scrollTop = 0;
  main.append(h('div', { class: 'content' }, h('p', { class: 'muted' }, 'Loading…')));
  try {
    const mod = (await page.load()).default;
    if (seq !== routeSeq) return;
    ui.clear(main);
    cleanup = mod.render(main, { ui, me, params, nav, refresh: route, isAdmin: me.role === 'hq_admin' });
  } catch (e) {
    if (seq !== routeSeq) return;
    console.error(e);
    ui.clear(main);
    main.append(ui.page({ title: page.title }, ui.empty({ icon: 'alert', title: 'Could not load this page', text: e.message })));
  }
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function buildShell() {
  shell?.remove();
  rail = h('nav', { class: 'rail', 'aria-label': 'HQ' },
    h('a', { class: 'rail-logo hq-logo', href: '#/overview', title: `${BRAND.name} HQ` }, icon('zap', 20), h('span', null, 'HQ')),
    PAGES.map((p) => h('a', { class: 'rail-btn', href: `#/${p.id}`, dataset: { page: p.id }, 'aria-label': p.title }, icon(p.icon, 22), h('span', { class: 'tip' }, p.title))),
    h('div', { class: 'rail-bottom' },
      h('button', { class: 'rail-btn', 'aria-label': 'Toggle dark mode', onClick: toggleTheme }, icon(isDark() ? 'sun' : 'moon', 20), h('span', { class: 'tip' }, 'Theme')),
      h('button', { class: 'rail-btn', 'aria-label': 'Sign out', onClick: signOut },
        h('span', { class: 'avatar hq-avatar' }, ui.initials(me.name)), h('span', { class: 'tip' }, `${me.name} (${me.role === 'hq_admin' ? 'HQ admin' : 'HQ staff'}) · sign out`))));
  main = h('main', { class: 'main', id: 'main' });
  shell = h('div', { class: 'app hq' }, rail, main);
  document.body.append(shell);
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('kc.theme', next); } catch { /* storage blocked */ }
  buildShell();
  route();
}

async function signOut() {
  try { await post('/api/v1/auth/logout'); } catch { /* already gone */ }
  me = null;
  shell?.remove();
  gate();
}

/** Who is signed in? Staff with MFA get the console; everyone else the sign-in flow. */
async function gate() {
  try {
    me = (await api('/api/hq/me', { quiet: true })).user;
  } catch (e) {
    me = null;
    shell?.remove();
    const step = e.code === 'mfa_required' ? 'verify' : e.code === 'mfa_enrolment_required' ? 'enrol' : e.code === 'forbidden' ? 'not-staff' : e.code === 'offline' ? 'offline' : 'password';
    showSignIn({ step, ui, onDone: gate, onSignOut: signOut, error: step === 'offline' ? e.message : null });
    return;
  }
  document.querySelector('.hq-signin')?.remove();
  buildShell();
  route();
}

/** Keep the app's offline worker away from HQ pages and data (see /hq/sw.js). */
async function isolateFromAppWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/hq/sw.js', { scope: '/hq/' });
    const mine = () => navigator.serviceWorker.controller?.scriptURL?.endsWith('/hq/sw.js');
    if (!navigator.serviceWorker.controller || mine()) return;
    await Promise.race([
      new Promise((res) => navigator.serviceWorker.addEventListener('controllerchange', res, { once: true })),
      new Promise((res) => setTimeout(res, 3000)),
    ]);
    void reg;
  } catch { /* unsupported or blocked: requests still work */ }
}

async function boot() {
  try { const t = localStorage.getItem('kc.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  ui.setCurrency('CAD');
  await isolateFromAppWorker();
  document.getElementById('boot')?.remove();
  addEventListener('hashchange', route);
  onAuthProblem(() => { if (me) { me = null; gate(); } });
  gate();
}

boot();
