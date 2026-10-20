// Notifications: the bell in the rail (unread count, a panel of recent items) and #/notifications
// (everything, the daily email setting). Items come from the server (GET /api/v1/notifications:
// payments, AI suggestions, Facebook leads...) and from this device's records (jobs I'm on, time
// to approve, expiring permits and licences; lib/notify.js). Derived items' read state is kept per
// person and company in the store's meta. Announcements plug in with addNotificationSource().
import { store } from '../store.js';
import { auth } from '../auth.js';
import { api } from '../session.js';
import { deriveNotifications, mergeNotifications, unreadCount, pruneReadKeys, timeAgo, KIND_ICON, KIND_LABEL } from '../lib/notify.js';

export { addNotificationSource } from '../lib/notify.js';

export const BELL = '<path d="M6 9a6 6 0 0112 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 004 0"/>';
const POLL_MS = 60_000;
const READ_META = 'notify.read';

// ---- shared state (one per page load) ----------------------------------------------

const state = { server: [], serverUnread: 0, online: false, loaded: false, error: null };
const listeners = new Set();
let pollTimer = null, recalcTimer = null, started = false;

const synced = () => auth.synced && store.synced;
const me = () => ({ employeeId: auth.current()?.id || null, can: (p) => auth.can(p) });
const readKeys = () => new Set(store.meta(READ_META) || []);

/** The merged list, newest first, with unread flags. */
export function items() {
  const derived = deriveNotifications(store, me());
  return mergeNotifications(state.server, derived, readKeys());
}
export function unread() { return unreadCount(items()) + Math.max(0, state.serverUnread - state.server.filter((n) => !n.readAt).length); }

function changed() { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } } }
export function onNotifications(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Fetch the latest server notifications (signed in only). */
export async function refresh() {
  if (!synced()) { state.loaded = true; changed(); return; }
  try {
    const r = await api.get('/api/v1/notifications?limit=50');
    state.server = r.data || [];
    state.serverUnread = r.unread || 0;
    state.online = true;
    state.error = null;
  } catch (e) {
    state.online = false;
    state.error = e;
  }
  state.loaded = true;
  changed();
}

/** Mark items read (server ids and derived keys). */
export async function markRead(list) {
  const ids = list.filter((i) => i.server && !i.read).map((i) => i.id);
  const keys = list.filter((i) => !i.server).map((i) => i.key);
  if (keys.length) {
    const next = new Set([...readKeys(), ...keys]);
    store.setMeta(READ_META, pruneReadKeys(next, deriveNotifications(store, me())));
  }
  if (ids.length) {
    for (const n of state.server) if (ids.includes(n.id)) n.readAt = new Date().toISOString();
    state.serverUnread = Math.max(0, state.serverUnread - ids.length);
    try { const r = await api.patch('/api/v1/notifications', { ids, read: true }); state.serverUnread = r.unread; } catch { /* offline: it shows read here; the server catches up next time */ }
  }
  changed();
}

export async function markAllRead() {
  store.setMeta(READ_META, deriveNotifications(store, me()).map((d) => d.key).slice(-500));
  for (const n of state.server) n.readAt ||= new Date().toISOString();
  state.serverUnread = 0;
  changed();
  if (synced()) { try { await api.patch('/api/v1/notifications', { all: true, read: true }); } catch { /* next refresh */ } }
}

function start() {
  if (started) return;
  started = true;
  refresh();
  pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  // Records change in bursts (a sync pull, an import): work the derived items out once it settles.
  store.on('*', (e) => {
    if (e.coll === 'auditLog') return;
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(changed, 600);
  });
}

// ---- the bell in the rail ----------------------------------------------------------

/** The rail button. `ui` is ui.js; `nav` the router's nav. */
export function notifyBell(ui) {
  const { h } = ui;
  const btn = h('button', { class: 'rail-btn notify-bell', 'aria-label': 'Notifications', 'aria-haspopup': 'dialog', onClick: () => openPanel(ui) });
  const paint = () => {
    if (!btn.isConnected && started && btn.dataset.painted) return;
    btn.dataset.painted = '1';
    const n = unread();
    h(ui.clear(btn), null, ui.icon(BELL, 22), n ? h('span', { class: 'notify-count', 'aria-hidden': 'true' }, n > 99 ? '99+' : String(n)) : null,
      h('span', { class: 'tip' }, n ? `${n} unread notification${n === 1 ? '' : 's'}` : 'Notifications'));
    btn.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  };
  const off = onNotifications(() => { if (!btn.isConnected && btn.dataset.painted) { off(); return; } paint(); });
  paint();
  start();
  return btn;
}

function row(ui, it, { onOpen } = {}) {
  const { h } = ui;
  return h(it.link ? 'a' : 'div', {
    class: ['list-row', 'notify-row', it.link ? 'click' : null, it.read ? 'read' : 'unread'], href: it.link || null,
    onClick: () => { markRead([it]); onOpen?.(); },
  },
  h('span', { class: ['notify-ico', it.tone || 'info'] }, ui.icon(KIND_ICON[it.kind] || 'info', 16)),
  h('div', { class: 'grow', style: { minWidth: '0' } },
    h('div', { class: 'title' }, it.title),
    h('div', { class: 'meta' }, [KIND_LABEL[it.kind] || it.kind, it.body, timeAgo(it.at)].filter(Boolean).join(' · '))),
  it.read ? null : h('span', { class: 'notify-dot', 'aria-label': 'unread' }));
}

export function openPanel(ui) {
  const { h } = ui;
  const body = h('div', { class: 'stack notify-panel' });
  let sheet;
  const draw = () => {
    ui.clear(body);
    const list = items();
    const n = unreadCount(list);
    h(body, null, // h() skips nulls; Element.append would print "null"
      h('div', { class: 'row' }, h('span', { class: 'muted grow' }, n ? `${n} unread` : 'All caught up'),
        n ? ui.button('Mark all read', { size: 'sm', variant: 'ghost', icon: 'check', onClick: () => markAllRead() }) : null),
      state.error && synced() ? h('div', { class: 'muted notify-offline' }, ui.icon('alert', 14), " Couldn't reach the server; showing what's on this device.") : null,
      list.length ? h('div', { class: 'list' }, list.slice(0, 20).map((it) => row(ui, it, { onOpen: () => sheet.close() })))
        : ui.empty({ icon: 'check', title: 'Nothing new', text: 'Payments, leads, jobs you are on and things about to expire show up here.' }));
  };
  const off = onNotifications(draw);
  sheet = ui.openSheet({
    title: 'Notifications', body,
    actions: [h('span', { class: 'grow' }), ui.button('See all', { variant: 'primary', icon: 'list', onClick: () => { sheet.close(); location.hash = '#/notifications'; } })],
    onClose: off,
  });
  draw();
  refresh();
  return sheet;
}

// ---- #/notifications ------------------------------------------------------------------

export default {
  id: 'notifications',
  title: 'Notifications',
  icon: BELL,
  group: 'home',
  perm: 'dashboard',
  hidden: true, // the bell is the way in
  render(root, ctx) {
    const { ui } = ctx;
    const { h } = ui;
    let filter = ctx.query.filter === 'unread' ? 'unread' : 'all';
    const tabsHost = h('div');
    const listHost = h('div');
    const prefsHost = h('div');
    const draw = () => {
      ui.clear(tabsHost).append(ui.tabs([{ id: 'all', label: 'All' }, { id: 'unread', label: `Unread ${unread() || ''}`.trim() }], filter, (f) => { filter = f; draw(); }));
      const list = items().filter((i) => filter === 'all' || !i.read);
      ui.clear(listHost).append(list.length ? h('div', { class: 'list card flat', style: { padding: '0' } }, list.map((it) => row(ui, it)))
        : ui.empty({ icon: 'check', title: filter === 'unread' ? 'No unread notifications' : 'No notifications yet', text: 'Payments, leads, AI suggestions, jobs you are on, time to approve and expiring permits and licences show up here.' }));
    };
    const drawPrefs = async () => {
      ui.clear(prefsHost);
      if (!synced()) { prefsHost.append(h('p', { class: 'muted' }, 'Sign in to your company to get server notifications and the daily email.')); return; }
      let prefs;
      try { prefs = await api.get('/api/v1/notifications/prefs'); } catch { prefsHost.append(h('p', { class: 'muted' }, 'The email setting needs a connection.')); return; }
      const box = h('input', { type: 'checkbox', checked: prefs.digest, onChange: async () => {
        box.disabled = true;
        try { await api.put('/api/v1/notifications/prefs', { digest: box.checked }); ui.toast(box.checked ? 'Daily email on' : 'Daily email off', 'success'); } catch (e) { box.checked = !box.checked; ui.toast(e.message, 'error'); }
        box.disabled = false;
      } });
      prefsHost.append(h('label', { class: 'field check' }, box, h('span', null, 'Email me a daily summary of what I haven’t read (sent in the morning, only when there is something new)')));
    };
    root.append(ui.page({
      title: 'Notifications', subtitle: 'What needs you, from the office, the field and online',
      actions: [ui.button('Mark all read', { icon: 'check', onClick: () => markAllRead() })],
    }, h('div', { class: 'row', style: { marginBottom: 'var(--s3)' } }, tabsHost), listHost, ...ui.section('Email'), prefsHost));
    draw(); drawPrefs(); refresh();
    return onNotifications(draw);
  },
};
