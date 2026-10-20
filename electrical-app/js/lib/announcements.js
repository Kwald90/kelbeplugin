// "What's new" banners from Fishtape HQ, and updated terms to accept. app.js starts this once
// when signed in (synced mode). It asks GET /api/v1/announcements now, when the app comes
// back into focus (at most every 10 minutes) and every 30 minutes; banners stack at the top
// of the screen until dismissed (stored per person on the server). Updated legal documents
// that HQ marked "accept again" open a dialog until accepted.

const EVERY_MS = 30 * 60_000;
const FOCUS_MIN_MS = 10 * 60_000;

/** Only https links and in-app #/routes; anything else is dropped. */
export function safeLink(url) {
  const u = String(url || '');
  if (/^#\/[A-Za-z0-9/_?=&.-]*$/.test(u)) return { href: u, external: false };
  if (/^https:\/\/[^\s<>"']+$/.test(u)) return { href: u, external: true };
  return null;
}

/** Banners not yet shown or dismissed, newest first (dedupes by id). */
export function pending(list, hidden) {
  const seen = new Set();
  return (list || []).filter((a) => a && a.id && !hidden.has(a.id) && !seen.has(a.id) && seen.add(a.id));
}

const DOC_NAME = { terms: 'Terms of Service', privacy: 'Privacy Policy' };

/**
 * @param {{ ui: typeof import('../ui.js'), api: { get: Function, post: Function } }} deps
 */
export function startAnnouncements({ ui, api }) {
  const { h } = ui;
  const hidden = new Set();
  let host = null;
  let last = 0;
  let legalOpen = false;
  let legalWait = null;

  /** Banners sit at the top of the page, in the flow (never over content or dialogs). */
  function place() {
    const main = document.getElementById('main');
    if (!host || !main) return;
    if (main.classList.contains('full-bleed') || !host.children.length) { host.remove(); return; }
    if (host.parentElement !== main) main.prepend(host);
  }

  function ensureHost() {
    host ||= h('div', { class: 'ann-host no-print', role: 'region', 'aria-label': 'Announcements' });
    return host;
  }

  function bar(a) {
    const link = safeLink(a.linkUrl);
    const el = h('div', { class: ['ann-bar', `tone-${a.tone || 'info'}`], role: 'status' },
      ui.icon(a.tone === 'warning' ? 'alert' : a.tone === 'success' ? 'check' : 'info', 18),
      h('div', { class: 'grow' },
        h('strong', null, a.title),
        a.body ? h('div', { class: 'ann-text' }, a.body) : null,
        link ? h('a', { class: 'ann-link', href: link.href, ...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}), onClick: () => { if (!link.external) dismiss(a, el, { quiet: true }); } }, a.linkLabel || 'Learn more') : null),
      a.dismissible ? h('button', { type: 'button', class: 'ann-x', 'aria-label': `Dismiss: ${a.title}`, onClick: () => dismiss(a, el) }, ui.icon('x', 16)) : null);
    return el;
  }

  async function dismiss(a, el, { quiet = false } = {}) {
    hidden.add(a.id);
    el.remove();
    place();
    if (!a.dismissible) return;
    try { await api.post(`/api/v1/announcements/${a.id}/dismiss`); } catch (e) { if (!quiet && e.status !== 404) ui.toast("Couldn't save that; it may show again.", 'error'); }
  }

  function legal(docs) {
    if (legalOpen || !docs?.length) return;
    // Wait for another dialog (e.g. the first-launch units question) to close first.
    if (document.querySelector('.dialog')) {
      legalWait ||= setTimeout(() => { legalWait = null; legal(docs); }, 1500);
      return;
    }
    legalOpen = true;
    let accepted = false;
    const list = h('ul', { class: 'ann-legal-list' }, docs.map((d) => {
      const link = safeLink(d.url) || (String(d.url || '').startsWith('/') ? { href: d.url, external: true } : null);
      return h('li', null, link ? h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer' }, DOC_NAME[d.doc] || d.doc) : (DOC_NAME[d.doc] || d.doc), ` (version ${d.version})`);
    }));
    const s = ui.openSheet({
      title: 'We updated our terms', dialog: true,
      body: h('div', { class: 'stack' }, h('p', { style: { margin: 0 } }, 'Please read and accept the updated documents to keep using Fishtape:'), list),
      actions: [
        ui.button('Later', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('I agree', { variant: 'primary', onClick: async () => {
          try {
            for (const d of docs) await api.post('/api/v1/legal/accept', { doc: d.doc, version: d.version });
            accepted = true;
            s.close();
            ui.toast('Thanks, accepted', 'success');
          } catch (e) { ui.toast(e.status === 409 ? 'They changed again; showing the latest.' : e.message, 'error'); if (e.status === 409) { s.close(); refresh(true); } }
        } }),
      ],
      onClose: () => { legalOpen = false; if (!accepted) last = 0; },
    });
  }

  async function refresh(force = false) {
    if (!force && Date.now() - last < FOCUS_MIN_MS) return;
    last = Date.now();
    let r;
    try { r = await api.get('/api/v1/announcements'); } catch { return; } // offline or older server: nothing to show
    const items = pending(r?.data, hidden);
    const root = ensureHost();
    const shown = new Set([...root.querySelectorAll('[data-ann]')].map((x) => x.dataset.ann));
    for (const el of root.querySelectorAll('[data-ann]')) if (!r.data.some((a) => a.id === el.dataset.ann)) el.remove();
    for (const a of items.slice(0, 3)) {
      if (shown.has(a.id)) continue;
      const el = bar(a);
      el.dataset.ann = a.id;
      root.append(el);
    }
    place();
    legal(r?.legal);
  }

  // The shell clears #main on every route and builds a new one on a theme change: put the banners back.
  addEventListener('hashchange', () => setTimeout(place, 0));
  // Screens may also redraw themselves (ui.clear(root)); watch for the banners being dropped.
  new MutationObserver(() => { if (host && host.children.length && !host.isConnected) place(); }).observe(document.body, { childList: true, subtree: true });
  refresh(true);
  addEventListener('focus', () => { refresh(); });
  setInterval(() => { if (!document.hidden) refresh(true); }, EVERY_MS);
  return { refresh };
}
