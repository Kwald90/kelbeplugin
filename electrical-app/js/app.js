// Boot, shell (floating rail + radial wheel) and hash router.
import { store } from './store.js';
import { auth, ROLES } from './auth.js';
import * as ui from './ui.js';
import { MODULES, GROUPS } from './modules/index.js';
import { seedIfEmpty } from './seed.js';

const { h, icon } = ui;
let main, rail, cleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { id: parts[0] || 'dashboard', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function nav(path) {
  const next = path.startsWith('#') ? path : '#/' + path.replace(/^\//, '');
  if (location.hash === next) route(); else location.hash = next;
}

function route() {
  const { id, params, query } = parseHash();
  const mod = MODULES.find((m) => m.id === id) || MODULES[0];
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  ui.clear(main);
  main.className = 'main' + (mod.fullBleed ? ' full-bleed' : '');
  main.scrollTop = 0;
  document.title = `${mod.title} · Kelbe Circuit`;
  for (const a of rail.querySelectorAll('[data-mod]')) {
    if (a.dataset.mod === mod.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (!auth.can(mod.perm)) {
    main.append(ui.page({ title: mod.title }, ui.empty({ icon: 'lock', title: 'No access', text: `Your role (${ROLES[auth.role()]?.label}) can't open ${mod.title}. Ask an owner or admin.` })));
    return;
  }
  try {
    cleanup = mod.render(main, { params, query, store, ui, auth, nav, route });
  } catch (e) {
    console.error(e);
    main.append(ui.page({ title: mod.title }, ui.empty({ icon: 'alert', title: 'Something went wrong', text: e.message })));
  }
}

function buildRail() {
  rail = h('nav', { class: 'rail', 'aria-label': 'Main' });
  rail.append(h('a', { class: 'rail-logo', href: '#/dashboard', title: 'Kelbe Circuit' }, icon('zap', 22)));
  let lastGroup = null;
  for (const m of MODULES) {
    if (m.hidden || !auth.can(m.perm)) continue;
    if (lastGroup && m.group !== lastGroup) rail.append(h('div', { class: 'rail-sep' }));
    lastGroup = m.group;
    rail.append(h('a', { class: 'rail-btn', href: '#/' + m.id, dataset: { mod: m.id }, 'aria-label': m.title }, icon(m.icon, 22), h('span', { class: 'tip' }, m.title)));
  }
  const u = auth.current();
  rail.append(h('div', { class: 'rail-bottom' },
    h('button', { class: 'rail-btn', 'aria-label': 'Toggle dark mode', onClick: toggleTheme }, icon(isDark() ? 'sun' : 'moon', 20), h('span', { class: 'tip' }, 'Theme')),
    h('button', { class: 'rail-btn', 'aria-label': 'Switch user', onClick: switchUser },
      h('span', { class: 'avatar', style: { background: u.color || '#5f5a51' } }, ui.initials(u.name)), h('span', { class: 'tip' }, `${u.name} · switch user`))));
  return rail;
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('kc.theme', next); } catch { /* ignore */ }
  rebuild();
}

function switchUser() {
  const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const s = ui.openSheet({
    title: 'Who is using this device?', dialog: true,
    body: h('div', { class: 'list' }, people.length ? people.map((p) => h('div', {
      class: 'list-row click', tabindex: 0,
      onClick: async () => {
        let pin = null;
        if (p.pin) { pin = await ui.promptDialog(`PIN for ${p.name}`, { title: 'Enter PIN' }); if (pin == null) return; }
        if (!auth.signIn(p.id, pin)) return ui.toast('Wrong PIN', 'error');
        s.close(); rebuild(); ui.toast(`Signed in as ${p.name}`, 'success');
      },
    }, h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'meta' }, ROLES[p.role]?.label || p.role)),
      p.pin ? icon('lock', 16) : null)) : h('p', { class: 'muted' }, 'Add employees first.')),
  });
}

// ---------- the wheel: a radial quick menu, our take on Concepts' tool wheel ----------
const WHEEL = [
  { label: 'Clock', icon: 'clock', go: 'time', perm: 'time' },
  { label: 'Draw', icon: 'pen', go: 'drawings/new', perm: 'drawings' },
  { label: 'Lead', icon: 'funnel', go: 'leads?new=1', perm: 'leads' },
  { label: 'Quote', icon: 'file-text', go: 'estimates/new', perm: 'estimates' },
  { label: 'Job', icon: 'briefcase', go: 'jobs?new=1', perm: 'jobs' },
  { label: 'Invoice', icon: 'receipt', go: 'invoices/new', perm: 'invoices' },
  { label: 'Calc', icon: 'calculator', go: 'calcs', perm: 'calcs' },
  { label: 'SOPs', icon: 'book', go: 'sops', perm: 'sops' },
];

function buildWheel() {
  const items = WHEEL.filter((w) => auth.can(w.perm));
  const scrim = h('div', { class: 'wheel-scrim', onClick: () => toggle(false) });
  const wheel = h('div', { class: 'wheel', 'aria-hidden': 'true' }, h('div', { class: 'wheel-disc' }));
  items.forEach((w, i) => {
    // spread items over the upper-left 3/4 of the circle so they stay on screen in the corner
    const a = Math.PI * (0.5 + (1.25 * i) / Math.max(1, items.length - 1)) + Math.PI * 0.12;
    const r = 118;
    wheel.append(h('button', {
      class: 'wheel-item', style: { left: `${150 + r * Math.cos(a)}px`, top: `${150 - r * Math.sin(a)}px` }, tabindex: -1,
      onClick: () => { toggle(false); nav(w.go); },
    }, icon(w.icon, 20), w.label));
  });
  const fab = h('button', { class: 'wheel-fab no-print', 'aria-label': 'Quick actions', 'aria-expanded': 'false', onClick: () => toggle() },
    h('span', { class: 'ring' }), icon('plus', 26));
  function toggle(force) {
    const open = force ?? fab.getAttribute('aria-expanded') !== 'true';
    fab.setAttribute('aria-expanded', String(open));
    wheel.classList.toggle('open', open); scrim.classList.toggle('open', open);
    wheel.setAttribute('aria-hidden', String(!open));
    for (const b of wheel.querySelectorAll('button')) b.tabIndex = open ? 0 : -1;
    if (open) wheel.querySelector('button')?.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
  return [scrim, wheel, fab];
}

let shell;
function rebuild() {
  shell?.remove();
  for (const el of document.querySelectorAll('.wheel, .wheel-scrim, .wheel-fab')) el.remove();
  main = h('main', { class: 'main', id: 'main' });
  shell = h('div', { class: 'app' }, buildRail(), main);
  document.body.append(shell, ...buildWheel());
  route();
}

async function boot() {
  try { const t = localStorage.getItem('kc.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  await store.ready;
  seedIfEmpty(store);
  ui.setCurrency(store.settings().currency);
  store.setActor(auth.current().id);
  addEventListener('hashchange', route);
  // Settings can change the theme too; keep the rail's sun/moon in step.
  new MutationObserver(() => {
    const btn = rail?.querySelector('[aria-label="Toggle dark mode"]');
    btn?.firstChild?.replaceWith(icon(isDark() ? 'sun' : 'moon', 20));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  store.on('*', (e) => { if (e.type === 'reset') rebuild(); });
  document.getElementById('boot')?.remove();
  rebuild();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();

// Exposed for tests and the browser console.
globalThis.kelbe = { store, auth, nav, MODULES, GROUPS };
