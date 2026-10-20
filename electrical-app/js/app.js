// Boot, shell (floating rail + radial wheel) and hash router.
//
// Boot modes:
//   synced   signed in (/api/v1/me answers): the company's own database, synced with the API
//   offline  the API can't be reached but this device was signed in: cached data, quiet banner
//   demo     "Try the demo on this device": local-only sample data, never syncs
//   gate     not signed in: sign-in, two-step sign-in, password reset, crew PIN (modules/account.js)
import { store, userDatabases, deleteDatabase } from './store.js';
import { auth, ROLES } from './auth.js';
import * as ui from './ui.js';
import { MODULES, GROUPS } from './modules/index.js';
import account, { renderGate, holdResetToken, holdWelcomeToken, upgradeCard, readOnlyBanner, openSyncSheet, syncLabel } from './modules/account.js';
import { trialBannerText } from './lib/trial.js';
import { seedIfEmpty } from './seed.js';
import { BRAND } from './brand.js';
import { hasUnitsChoice, setUnits, getUnits } from './lib/units.js';
import { session, api, syncPrefs } from './session.js';
import { createSync } from './sync.js';
import { FEATURE_PLAN, hasFeature } from './plans.js';
import { notifyBell } from './modules/notifications.js';
import { moduleOn, linkOn, hrefModule, SWITCHES } from './lib/modules.js';

const { h, icon } = ui;
const put = (el, ...kids) => h(ui.clear(el), null, ...kids);
// The Account page is part of the shell, not a plan module, so it is not in modules/index.js.
const ALL = [...MODULES, account];
// Records each plan-gated module shows, to offer read-only viewing after a downgrade.
const MODULE_COLLECTIONS = {
  drawings: ['drawings'], panels: ['panels'], inventory: ['items', 'locations', 'stockMoves'],
  compliance: ['permits', 'inspections', 'certifications', 'checklists'], sequences: ['sequences', 'enrolments', 'outbox'],
  security: ['checklists'], wireruns: ['wireRuns'], bending: ['bends', 'benderProfiles'],
  workplan: ['workPlans', 'workTasks', 'taskTemplates', 'huddles'], materials: ['materialRequests'],
};
// Electricians and apprentices land on My day (their task list) instead of the dashboard.
const FIELD_ROLES = ['electrician', 'apprentice'];
let landed = false;

let main, rail, cleanup = null;
let mode = null; // 'synced' | 'demo'
let sync = null;
let syncStatus = null;
const statusListeners = new Set();
const viewingLocked = new Set(); // locked modules opened read-only this run
let banner = null;
let tracker = null;

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

/** Reload the app on a route: after sign-in, sign-out or a company switch nothing stays in memory. */
function restart(hash = 'dashboard') {
  history.replaceState(null, '', `${location.pathname}${location.search}#/${hash}`);
  location.reload();
}

// ---------- module switches (Settings → Modules) ----------

// The switches, cached: store.settings() copies the whole record (logo included) on every call.
let switchCache = null;
const switchesNow = () => (switchCache ||= { modules: store.settings()?.modules ?? null });

/** Has the company turned this screen on? Separate from the plan: a switch hides, a plan locks. */
export function moduleEnabled(id) {
  return moduleOn(switchesNow(), id);
}

/** The switch that hides a module, for the "turned off" page. */
const switchFor = (id) => SWITCHES.find((s) => s.modules.includes(id)) || (id === 'inventory' ? SWITCHES.find((s) => s.id === 'inventory') : null);

/**
 * Links into turned-off modules disappear from every screen and sheet, whoever drew them
 * (dashboard tiles, job tabs, notification rows, help articles). Screens also leave out their
 * own buttons; this catches the rest.
 */
function sweepLinks(root) {
  const settings = switchesNow();
  if (!settings.modules) return;
  const links = root.matches?.('a[href^="#/"]') ? [root] : [];
  for (const a of [...links, ...(root.querySelectorAll?.('a[href^="#/"]') || [])]) {
    if (a.closest('.rail, [data-keep-links]')) continue;
    if (!linkOn(settings, a.getAttribute('href'))) a.remove();
  }
}
let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  sweeper = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) sweepLinks(n);
  });
  sweeper.observe(document.body, { childList: true, subtree: true });
}
let modulesKey = null;
const currentModulesKey = () => JSON.stringify(switchesNow().modules);

// ---------- plans ----------

/** Is the module in the company's plan? Demo mode and unknown modules are always open. */
export function moduleUnlocked(id) {
  const ent = mode === 'synced' ? session.me?.entitlements : null;
  if (!ent || !Object.hasOwn(FEATURE_PLAN, id)) return true;
  // /me sends the unlocked feature keys (plan + HQ overrides); hand them to hasFeature as overrides.
  const overrides = Object.fromEntries(Object.keys(FEATURE_PLAN).map((f) => [f, ent.features.includes(f)]));
  return hasFeature(ent.plan, id, overrides);
}

/**
 * "12 days left in your trial" for the people who can pick a plan (Billing), on every screen
 * but Billing itself and full-screen tools. Hidden for the session once closed, until the
 * text changes the next day.
 */
function trialBanner(mod) {
  if (mode !== 'synced' || mod.fullBleed || mod.id === 'billing' || !auth.can('settings')) return null;
  const text = trialBannerText(session.me?.entitlements);
  if (!text) return null;
  try { if (sessionStorage.getItem('ft.trialBanner') === text) return null; } catch { /* storage blocked */ }
  const bar = h('div', { class: 'trial-banner no-print', role: 'status' },
    icon('clock', 16), h('span', { class: 'grow' }, text),
    h('a', { href: '#/billing' }, 'Billing'),
    h('button', {
      type: 'button', class: 'trial-banner-x', 'aria-label': 'Hide for now',
      onClick: () => { try { sessionStorage.setItem('ft.trialBanner', text); } catch { /* storage blocked */ } bar.remove(); },
    }, icon('x', 14)));
  return bar;
}

function hasRecords(id) {
  const colls = MODULE_COLLECTIONS[id];
  return colls ? colls.some((c) => store.count(c) > 0) : true;
}

// ---------- router ----------

function route() {
  if (!main) return;
  const { id, params, query } = parseHash();
  if (['sign-in', 'reset-password', 'forgot-password', 'welcome'].includes(id)) { nav('dashboard'); return; }
  if (!landed) {
    landed = true;
    if (id === 'dashboard' && FIELD_ROLES.includes(auth.role()) && auth.can('today') && moduleUnlocked('today') && moduleEnabled('today')) { nav('today'); return; }
  }
  const mod = ALL.find((m) => m.id === id) || MODULES[0];
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  ui.clear(main);
  main.className = 'main' + (mod.fullBleed ? ' full-bleed' : '');
  main.scrollTop = 0;
  document.title = `${mod.title} · ${BRAND.name}`;
  for (const a of rail.querySelectorAll('[data-mod]')) {
    if (a.dataset.mod === mod.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (!auth.can(mod.perm)) {
    main.append(ui.page({ title: mod.title }, ui.empty({ icon: 'lock', title: 'No access', text: `Your role (${ROLES[auth.role()]?.label}) can't open ${mod.title}. Ask an owner or admin.` })));
    return;
  }
  if (!moduleEnabled(mod.id)) {
    const sw = switchFor(mod.id);
    main.append(ui.page({ title: mod.title }, ui.empty({
      icon: 'eye-off', title: `${sw?.label || mod.title} is turned off`,
      text: auth.isAdmin() ? 'Your company turned this module off. Everything in it is kept; turn it back on to see it again.' : 'Your company turned this module off. Everything in it is kept. An owner or admin can turn it back on.',
      action: auth.isAdmin() && auth.can('settings') ? ui.button('Settings → Modules', { variant: 'primary', icon: 'sliders', href: '#/settings?section=modules' }) : ui.button('Back to the dashboard', { href: '#/dashboard' }),
    })));
    return;
  }
  const locked = !moduleUnlocked(mod.id);
  if (locked && !viewingLocked.has(mod.id)) {
    main.className = 'main';
    main.append(upgradeCard(mod, { auth, hasData: hasRecords(mod.id), entitlements: session.me?.entitlements, onView: () => { viewingLocked.add(mod.id); route(); } }));
    return;
  }
  try {
    cleanup = mod.render(main, { params, query, store, ui, auth, nav, route, app: shellApi, on: moduleEnabled });
    if (locked) main.prepend(readOnlyBanner(mod));
    const trial = trialBanner(mod);
    if (trial) main.prepend(trial);
  } catch (e) {
    console.error(e);
    main.append(ui.page({ title: mod.title }, ui.empty({ icon: 'alert', title: 'Something went wrong', text: e.message })));
  }
}

// ---------- rail ----------

function buildRail() {
  rail = h('nav', { class: 'rail', 'aria-label': 'Main' });
  rail.append(h('a', { class: 'rail-logo', href: '#/dashboard', title: BRAND.name }, icon('zap', 22)));
  let lastGroup = null;
  for (const m of MODULES) {
    if (m.hidden || !auth.can(m.perm) || !moduleEnabled(m.id)) continue;
    if (lastGroup && m.group !== lastGroup) rail.append(h('div', { class: 'rail-sep' }));
    lastGroup = m.group;
    const locked = !moduleUnlocked(m.id);
    rail.append(h('a', { class: ['rail-btn', locked ? 'locked' : null], href: '#/' + m.id, dataset: { mod: m.id }, 'aria-label': locked ? `${m.title} (not in your plan)` : m.title },
      icon(m.icon, 22), locked ? h('span', { class: 'rail-lock', 'aria-hidden': 'true' }, icon('lock', 11)) : null,
      h('span', { class: 'tip' }, locked ? `${m.title} · upgrade` : m.title)));
  }
  const u = auth.current();
  rail.append(h('div', { class: 'rail-bottom' },
    notifyBell(ui),
    mode === 'synced' ? syncButton() : demoButton(),
    h('button', { class: 'rail-btn', 'aria-label': 'Toggle dark mode', onClick: toggleTheme }, icon(isDark() ? 'sun' : 'moon', 20), h('span', { class: 'tip' }, 'Theme')),
    mode === 'synced'
      ? h('a', { class: 'rail-btn', href: '#/account', dataset: { mod: 'account' }, 'aria-label': 'Account' },
        h('span', { class: 'avatar', style: { background: u.color || '#5f5a51' } }, ui.initials(u.name)), h('span', { class: 'tip' }, `${u.name} · ${auth.account?.tenantName || 'account'}`))
      : h('button', { class: 'rail-btn', 'aria-label': 'Switch user', onClick: switchUser },
        h('span', { class: 'avatar', style: { background: u.color || '#5f5a51' } }, ui.initials(u.name)), h('span', { class: 'tip' }, `${u.name} · switch user`))));
  return rail;
}

function syncButton() {
  const btn = h('button', { class: 'rail-btn sync-btn', 'aria-label': 'Sync status', onClick: () => openSyncSheet(shellApi) });
  paintSync(btn, syncStatus);
  return btn;
}

function paintSync(btn, s) {
  if (!btn) return;
  const l = syncLabel(s);
  btn.className = ['rail-btn', 'sync-btn', l.tone, s?.state === 'syncing' ? 'spinning' : null].filter(Boolean).join(' ');
  btn.setAttribute('aria-label', `Sync: ${l.text}`);
  const count = (s?.waiting || 0) + (s?.rejected || 0);
  put(btn, icon(l.icon, 22), count ? h('span', { class: 'sync-count' }, count > 99 ? '99+' : String(count)) : null, h('span', { class: 'tip' }, l.text));
}

function demoButton() {
  return h('button', { class: 'rail-btn demo-btn', 'aria-label': 'Demo mode: sign in', onClick: () => nav('account') },
    h('span', { class: 'demo-chip' }, 'Demo'), h('span', { class: 'tip' }, 'Demo on this device · sign in'));
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('kc.theme', next); } catch { /* ignore */ }
  if (mode === 'synced') syncPrefs(session.me, { online: session.online }).catch(() => {});
  rebuild();
}

// Demo only: pick who is using the device (signed-in users get the Account page instead).
function switchUser() {
  const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const s = ui.openSheet({
    title: 'Who is using this device?', dialog: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'list' }, people.length ? people.map((p) => h('div', {
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
      h('p', { class: 'muted', style: { margin: 0 } }, 'Demo mode: data stays on this device and never syncs.')),
    actions: [ui.button('Sign in to your company', { variant: 'primary', icon: 'key', onClick: () => { s.close(); leaveDemo(); } })],
  });
}

async function leaveDemo() {
  session.setDemo(false);
  await stopTracking();
  restart('sign-in');
}

// ---------- the wheel: a radial quick menu, our take on Concepts' tool wheel ----------
const WHEEL = [
  { label: 'Clock', icon: 'clock', go: 'time', perm: 'time' },
  { label: 'Draw', icon: 'pen', go: 'drawings/new', perm: 'drawings' },
  { label: 'Lead', icon: 'funnel', go: 'leads?new=1', perm: 'leads' },
  { label: 'Quote', icon: 'file-text', go: 'estimates/new', perm: 'estimates' },
  { label: 'Job', icon: 'briefcase', go: 'jobs?new=1', perm: 'jobs' },
  { label: 'Material', icon: 'truck', go: 'materials?new=1', perm: 'jobs' },
  { label: 'Invoice', icon: 'receipt', go: 'invoices/new', perm: 'invoices' },
  { label: 'Calc', icon: 'calculator', go: 'calcs', perm: 'calcs' },
  { label: 'SOPs', icon: 'book', go: 'sops', perm: 'sops' },
];

function buildWheel() {
  const items = WHEEL.filter((w) => auth.can(w.perm) && moduleUnlocked(w.go.split(/[/?]/)[0]) && moduleEnabled(hrefModule('#/' + w.go)));
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
  modulesKey = currentModulesKey();
  document.body.append(shell, ...buildWheel());
  route();
}

// ---------- banner (offline / demo) ----------

function paintBanner() {
  const offline = mode === 'synced' && syncStatus?.state === 'offline';
  const text = offline
    ? `Offline: showing what's on this device.${syncStatus.waiting ? ` ${syncStatus.waiting} change${syncStatus.waiting === 1 ? '' : 's'} will sync when you're back.` : ''}`
    : null;
  if (!text) { banner?.remove(); banner = null; return; }
  if (!banner) { banner = h('div', { class: 'net-banner no-print', role: 'status' }); document.body.append(banner); }
  put(banner, icon('alert', 14), h('span', null, text));
}

// ---------- the API the Account page and sheets use ----------

const shellApi = {
  store, session, api,
  get sync() { return sync; },
  onSyncStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
  refreshShell: () => rebuild(),
  signOut, switchCompany, leaveDemo, switchDemoUser: () => switchUser(),
};

/** Empty Cache Storage (threat model TM-WEB-04): nothing from this session stays in the service worker's caches. */
async function clearCacheStorage() {
  try { for (const k of await globalThis.caches?.keys?.() || []) await caches.delete(k); } catch { /* not available */ }
}

async function signOut({ keepData = false } = {}) {
  const shared = keepData || Boolean(session.device());
  if (sync) {
    try { await sync.syncNow(); } catch { /* offline */ }
    const { waiting } = sync.status();
    if (waiting && !shared) {
      const ok = await ui.confirmDialog(`${waiting} change${waiting === 1 ? " hasn't" : "s haven't"} reached the server yet. If you sign out now ${waiting === 1 ? 'it is' : 'they are'} lost.`, { title: 'Sign out anyway?', okLabel: 'Sign out' });
      if (!ok) return;
    }
    sync.stop();
  }
  await stopTracking();
  const userId = session.me?.user?.id;
  await session.logout();
  if (shared) {
    await store.close(); // a registered shared iPad keeps the company's data for the next crew member
  } else {
    // A personal device forgets this person's company data: every company database of theirs.
    await store.destroy();
    if (userId) for (const name of await userDatabases(userId)) await deleteDatabase(name);
    await clearCacheStorage();
  }
  session.forget();
  restart(session.device() ? '' : 'sign-in');
}

async function switchCompany(tenantId) {
  try { await sync?.syncNow(); } catch { /* offline: pending changes stay in this company's database */ }
  try {
    await api.post('/api/v1/auth/switch-tenant', { tenantId });
  } catch (e) { ui.toast(e.message, 'error'); return; }
  sync?.stop();
  await stopTracking();
  await store.close();
  if (!session.device()) await clearCacheStorage();
  restart('dashboard');
}

/** Location stops with the session: the iOS geofence would otherwise outlive the page (lib/shift-tracker.js). */
async function stopTracking() {
  try { await tracker?.stop?.(); } catch { /* not running */ }
}

function onSessionEnded(err) {
  const mfa = err?.code === 'mfa_required' || err?.code === 'mfa_enrolment_required';
  const s = ui.openSheet({
    title: mfa ? 'Two-step sign-in needed' : 'Signed out', dialog: true,
    body: h('p', { style: { margin: 0 } }, mfa ? 'Confirm it is you to keep syncing.' : 'Your session ended. Sign in again to keep syncing. Changes on this device are kept until you do.'),
    actions: [ui.button('Later', { variant: 'ghost', onClick: () => s.close() }), ui.button('Sign in', { variant: 'primary', onClick: () => restart('sign-in') })],
  });
}

/** Refresh /me (role, plan, prefs) when back online; the shell redraws when anything changed. */
let lastMeCheck = 0;
async function refreshMe() {
  if (mode !== 'synced' || Date.now() - lastMeCheck < 60_000) return;
  lastMeCheck = Date.now();
  const res = await session.load();
  if (res.state === 'signed-out') return onSessionEnded(res.error);
  if (res.state !== 'signed-in') return;
  const me = res.me;
  if (!me.tenant || me.tenant.id !== store.scope?.tenantId || me.user.id !== store.scope?.userId) return restart('dashboard');
  const before = JSON.stringify([auth.account?.role, auth.account?.perms, session.me?.entitlements]);
  store.setMeta('me', me);
  auth.setAccount(me);
  const changed = await syncPrefs(me, { online: true });
  if (changed.length || before !== JSON.stringify([auth.account?.role, auth.account?.perms, me.entitlements])) rebuild();
}

// ---------- boot ----------

function applyStoredTheme() {
  try { const t = localStorage.getItem('kc.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
}

function showGate(view, opts = {}) {
  document.getElementById('boot')?.remove();
  shell?.remove(); shell = null; main = null;
  const root = h('div', { class: 'gate' });
  document.body.append(root);
  document.title = `Sign in · ${BRAND.name}`;
  renderGate(root, view, {
    opts, restart,
    startDemo: () => { session.setDemo(true); restart('dashboard'); },
  });
  registerSW();
}

async function startShell() {
  // Settings can change the theme too; keep the rail's sun/moon in step.
  new MutationObserver(() => {
    const btn = rail?.querySelector('[aria-label="Toggle dark mode"]');
    btn?.firstChild?.replaceWith(icon(isDark() ? 'sun' : 'moon', 20));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  store.on('*', (e) => { if (e.type === 'reset') { switchCache = null; rebuild(); } });
  // A module turned on or off (here or on another device): redraw the rail, wheel and screen.
  store.on('settings', () => { switchCache = null; if (currentModulesKey() !== modulesKey) rebuild(); });
  startSweeper();
  addEventListener('hashchange', route);
  document.getElementById('boot')?.remove();
  rebuild();
  askUnitsOnce();
  registerSW();
  // Location while clocked in: on only while this person has an open shift (lib/shift-tracker.js).
  import('./lib/shift-tracker.js').then((m) => { tracker = m.startShiftTracker({ store, auth, ui, nav, app: shellApi }); }).catch((e) => console.error(e));
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}

async function startDemo() {
  mode = 'demo';
  await store.open({ kind: 'demo' });
  auth.setAccount(null);
  seedIfEmpty(store);
  ui.setCurrency(store.settings().currency);
  store.setActor(auth.current().id);
  await startShell();
}

/** Signed in (me from the server) or offline with this device's last company (me from cache). */
async function startSynced(me) {
  mode = 'synced';
  session.setDemo(false);
  const p = me ? { userId: me.user.id, tenantId: me.tenant.id } : session.pointer();
  const company = me?.tenant ? { name: me.tenant.name, ...(me.tenant.province ? { province: me.tenant.province } : {}) } : null;
  await store.open({ kind: 'company', userId: p.userId, tenantId: p.tenantId, company });
  if (me) {
    store.setMeta('me', me);
    session.remember(me);
    lastMeCheck = Date.now();
  } else {
    me = store.meta('me');
    if (!me?.tenant || me.user?.id !== p.userId) { await store.close(); session.forget(); return showGate('sign-in', { unreachable: true }); }
    session.me = me;
    session.online = false;
  }
  auth.setAccount(me);
  ui.setCurrency(store.settings().currency);
  syncPrefs(me, { online: session.online }).then((changed) => { if (changed.length && main) rebuild(); }).catch(() => {});

  sync = createSync({
    store, api,
    onStatus: (s) => {
      syncStatus = s;
      paintSync(rail?.querySelector('.sync-btn'), s);
      paintBanner();
      for (const fn of statusListeners) { try { fn(s); } catch (e) { console.error(e); } }
    },
    // Reached the server: after an offline start, check the session, role, plan and prefs.
    onSynced: () => {
      if (session.online) return;
      session.online = true;
      lastMeCheck = 0;
      refreshMe().catch(() => {});
    },
    onConflicts: (list) => ui.toast(list.length === 1 ? 'Updated from another device' : `${list.length} records updated from another device`, 'info', 3500),
    onRejected: (list) => ui.toast(`${list.length} change${list.length === 1 ? " wasn't" : "s weren't"} saved on the server. See Sync.`, 'error', 4500),
    onAuthError: onSessionEnded,
  });
  await startShell();
  addEventListener('focus', () => { refreshMe().catch(() => {}); });
  sync.start();
  import('./lib/announcements.js').then((m) => m.startAnnouncements({ ui, api })).catch((e) => console.error(e));
}

async function boot() {
  applyStoredTheme();
  const { id, query } = parseHash();
  // A one-time reset (or invite) token: keep it in memory and take it out of the address bar.
  if (id === 'reset-password') {
    if (query.token) holdResetToken(query.token);
    history.replaceState(null, '', `${location.pathname}${location.search}#/reset-password`);
    return showGate('reset');
  }
  // The sign-up welcome email's one-time link: same treatment as a reset token.
  if (id === 'welcome') {
    if (query.token) holdWelcomeToken(query.token);
    history.replaceState(null, '', `${location.pathname}${location.search}#/welcome`);
    return showGate('welcome');
  }
  // A link from the website (app.fishtapehq.com/#/demo) opens the device-only demo straight away.
  if (id === 'demo' && !session.isDemo()) { session.setDemo(true); history.replaceState(null, '', `${location.pathname}${location.search}#/dashboard`); }
  if (session.isDemo()) return startDemo();
  const res = await session.load();
  if (res.state === 'signed-in') {
    const me = res.me;
    if (me.session?.mfa) return showGate('mfa', { mfa: me.session.mfa });
    if (!me.tenant) return showGate('no-company', { me });
    if (id === 'sign-in') history.replaceState(null, '', `${location.pathname}${location.search}#/dashboard`);
    return startSynced(me);
  }
  if (res.state === 'offline') {
    if (session.pointer()) return startSynced(null);
    return showGate('sign-in', { unreachable: true });
  }
  // Not signed in. Error codes from Google/Microsoft come back as #/sign-in?error=<code>.
  const err = id === 'sign-in' ? query.error : null;
  if (id === 'sign-in') history.replaceState(null, '', `${location.pathname}${location.search}#/sign-in`);
  if (session.device() && !err && id !== 'sign-in') return showGate('crew');
  return showGate('sign-in', { error: err, expired: Boolean(session.pointer()) && !err });
}

// First launch on this device: ask once whether lengths show in metric or imperial.
// The company default (Settings) is preselected; Settings can switch it later.
function askUnitsOnce() {
  if (hasUnitsChoice()) return;
  const fallback = getUnits(store.settings().units);
  const choose = (u) => {
    setUnits(u); s.close();
    ui.toast(u === 'metric' ? 'Lengths in metres and millimetres' : 'Lengths in feet and inches', 'success');
    if (mode === 'synced') syncPrefs(session.me, { online: session.online }).catch(() => {});
    route();
  };
  const option = (u, title, text) => h('button', { type: 'button', class: ['list-row', 'click'], style: { width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', background: 'transparent', border: 0, borderBottom: '1px solid var(--border)' }, onClick: () => choose(u) },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'meta' }, text)),
    u === fallback ? ui.badge('Company default', 'accent') : null);
  const s = ui.openSheet({
    title: 'How do you measure?', dialog: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Lengths on drawings, wire runs, bends and calculators show in your choice. You can change it any time in Settings.'),
      h('div', { class: 'list' },
        option('metric', 'Metric', 'Metres and millimetres: 3.25 m, 450 mm'),
        option('imperial', 'Imperial', `Feet and inches: 12' 3 5/8"`))),
    // Closing without a choice keeps the company default until they pick.
    actions: [ui.button('Decide later', { variant: 'ghost', onClick: () => s.close() })],
  });
}

boot();

// Exposed for tests and the browser console.
globalThis.kelbe = { store, auth, nav, MODULES, GROUPS, session, moduleEnabled, get sync() { return sync; }, get tracker() { return tracker; } };
