// Help (#/help): Fishtape's help center. Search, categories and articles written by Fishtape
// HQ (GET /api/v1/help/articles), rendered with the app's safe Markdown renderer, and a
// "Contact support" form (POST /api/v1/support/requests). Needs a connection; demo mode shows
// how to reach support instead.
//   #/help            categories and articles
//   #/help/<slug>     one article
//   #/help/contact    the support form
import { renderMarkdown } from '../lib/markdown.js';
import { api, session } from '../session.js';

let lastPage = '';
// Remember where the person was before opening Help, so a support request says which screen.
addEventListener('hashchange', (e) => {
  try {
    const prev = new URL(e.oldURL).hash;
    if (prev && !prev.startsWith('#/help')) lastPage = prev.split('?')[0].slice(0, 200);
  } catch { /* old browsers */ }
});

const MAX_SHOT = 2 * 1024 * 1024;
let cache = null; // { categories, data, support, at }

async function loadIndex() {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache;
  const r = await api.get('/api/v1/help/articles');
  cache = { ...r, at: Date.now() };
  return cache;
}

export default {
  id: 'help',
  title: 'Help',
  icon: 'info',
  group: 'admin',
  perm: 'dashboard',
  render(root, { ui, params, nav, app }) {
    const { h } = ui;
    const signedIn = Boolean(app?.session?.me || session.me);
    const view = params[0] === 'contact' ? 'contact' : params[0] ? 'article' : 'index';
    const body = h('div', { class: 'stack help' });
    const actions = view === 'contact' ? [] : [ui.button('Contact support', { icon: 'mail', onClick: () => nav('help/contact') })];
    root.append(ui.page({ title: view === 'contact' ? 'Contact support' : 'Help', subtitle: view === 'index' ? 'How-to guides from the Fishtape team' : null, actions }, body));
    let alive = true;

    const offline = (e) => {
      ui.clear(body);
      const demo = !signedIn;
      body.append(ui.empty({
        icon: demo ? 'info' : 'alert',
        title: demo ? 'Help needs your Fishtape account' : 'Help is not available right now',
        text: demo ? 'Sign in to read the help center and contact support. In the demo, email support@fishtapehq.com.' : `${e?.message || 'No connection.'} Try again when you are back online.`,
        action: demo ? ui.button('Sign in', { variant: 'primary', onClick: () => nav('account') }) : ui.button('Try again', { onClick: () => { cache = null; nav(location.hash.slice(2) || 'help'); } }),
      }));
    };

    // ---- index ----------------------------------------------------------------------
    async function index() {
      body.append(h('p', { class: 'muted' }, 'Loading help…'));
      let idx;
      try { idx = await loadIndex(); } catch (e) { if (alive) offline(e); return; }
      if (!alive) return;
      let cat = '';
      let term = '';
      let hits = null;
      let timer = null;
      const listHost = h('div', { class: 'stack' });
      const chips = h('div', { class: 'help-chips', role: 'tablist', 'aria-label': 'Categories' });
      const drawChips = () => {
        ui.clear(chips);
        for (const c of [{ id: '', name: 'All' }, ...idx.categories]) {
          chips.append(h('button', { type: 'button', role: 'tab', class: 'help-chip', 'aria-selected': String(cat === c.id), onClick: () => { cat = c.id; hits = null; drawChips(); draw(); } }, c.name));
        }
      };
      const card = (a) => h('a', { class: 'card help-card', href: `#/help/${a.slug}` },
        h('div', { class: 'help-card-cat' }, a.categoryName || 'General'),
        h('strong', null, a.title),
        h('p', null, a.snippet || a.summary || ''));
      function draw() {
        ui.clear(listHost);
        const q = term.trim().toLowerCase();
        let rows = hits || idx.data.filter((a) => (!cat || a.categoryId === cat) && (!q || `${a.title} ${a.summary}`.toLowerCase().includes(q)));
        if (hits && cat) rows = rows.filter((a) => a.categoryId === cat);
        if (!rows.length) {
          listHost.append(ui.empty({ icon: 'search', title: 'Nothing found', text: 'Try other words, or ask us.', action: ui.button('Contact support', { onClick: () => nav('help/contact') }) }));
          return;
        }
        if (q || cat) { listHost.append(h('div', { class: 'help-grid' }, rows.map(card))); return; }
        for (const c of idx.categories) {
          const mine = rows.filter((a) => a.categoryId === c.id);
          if (mine.length) listHost.append(...ui.section(c.name, h('div', { class: 'help-grid' }, mine.map(card))));
        }
        const loose = rows.filter((a) => !idx.categories.some((c) => c.id === a.categoryId));
        if (loose.length) listHost.append(...ui.section('More', h('div', { class: 'help-grid' }, loose.map(card))));
      }
      const search = ui.searchBox('Search help', (v) => {
        term = v; hits = null; draw();
        clearTimeout(timer);
        if (v.trim().length >= 3) {
          timer = setTimeout(async () => {
            try { const r = await api.post('/api/v1/help/search', { q: v.trim() }); if (alive && term === v) { hits = r.data; draw(); } } catch { /* the local filter stands */ }
          }, 350);
        }
      });
      ui.clear(body);
      body.append(h('div', { class: 'help-search' }, search), chips, listHost,
        h('div', { class: 'card help-contact-card' }, ui.icon('mail', 20), h('div', { class: 'grow' }, h('strong', null, "Can't find it?"), h('div', { class: 'muted' }, `Send us a message from here, or email ${idx.support?.email || 'support'}.`)),
          ui.button('Contact support', { variant: 'primary', onClick: () => nav('help/contact') })));
      drawChips();
      draw();
    }

    // ---- article --------------------------------------------------------------------
    async function article(slug) {
      body.append(h('p', { class: 'muted' }, 'Loading…'));
      let a;
      try { a = await api.get(`/api/v1/help/articles/${encodeURIComponent(slug)}`); } catch (e) {
        if (!alive) return;
        if (e.status === 404) {
          ui.clear(body);
          body.append(ui.empty({ icon: 'search', title: 'No such article', text: 'It may have moved.', action: ui.button('All help', { onClick: () => nav('help') }) }));
          return;
        }
        offline(e);
        return;
      }
      if (!alive) return;
      document.title = `${a.title} · Help`;
      const content = h('div', { class: 'help-article' });
      // renderMarkdown escapes every piece of text and emits only a fixed set of tags and safe URLs.
      content.innerHTML = renderMarkdown(a.body, { origin: location.origin });
      ui.clear(body);
      body.append(
        h('div', { class: 'row' }, ui.button('All help', { variant: 'ghost', icon: 'chevron-left', onClick: () => nav('help') }), h('span', { class: 'grow' }), a.categoryName ? ui.badge(a.categoryName, 'info') : null),
        h('article', { class: 'card help-article-card' },
          h('h2', { class: 'help-title' }, a.title),
          a.summary ? h('p', { class: 'help-summary' }, a.summary) : null,
          content,
          h('p', { class: 'muted help-updated' }, `Updated ${ui.fmtDate(a.updatedAt)}`)),
        h('div', { class: 'card help-contact-card' }, ui.icon('mail', 20), h('div', { class: 'grow' }, h('strong', null, 'Still stuck?'), h('div', { class: 'muted' }, 'Tell us what you were trying to do.')),
          ui.button('Contact support', { onClick: () => nav('help/contact') })));
    }

    // ---- contact --------------------------------------------------------------------
    function contact() {
      const supportEmail = cache?.support?.email || 'support@fishtapehq.com';
      if (!signedIn) { offline(); return; }
      let shot = null;
      const status = h('div', { role: 'status', 'aria-live': 'polite' });
      const subject = h('input', { name: 'subject', required: true, maxlength: 150, placeholder: 'e.g. Scale is off on sheet E2' });
      const message = h('textarea', { name: 'message', required: true, rows: 7, maxlength: 5000, placeholder: 'What were you doing, what did you expect, and what happened?' });
      const shotName = h('span', { class: 'muted' }, 'No screenshot');
      const pick = ui.button('Attach a screenshot', { icon: 'image', onClick: async () => {
        const f = await ui.pickFile('image/png,image/jpeg,image/webp');
        if (!f) return;
        if (f.size > MAX_SHOT) { ui.toast('Pick an image under 2 MB', 'error'); return; }
        shot = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        shotName.textContent = f.name;
      } });
      const send = ui.button('Send', { variant: 'primary', type: 'submit', icon: 'send' });
      const form = h('form', { class: 'card stack help-form', onSubmit: async (e) => {
        e.preventDefault();
        if (!subject.value.trim() || !message.value.trim()) return;
        send.disabled = true;
        ui.clear(status);
        try {
          await api.post('/api/v1/support/requests', { subject: subject.value.trim(), message: message.value.trim(), page: lastPage || '#/help', ...(shot ? { screenshot: shot } : {}) });
          ui.clear(form);
          form.append(ui.empty({ icon: 'check', title: 'Message sent', text: 'We usually reply by email within one business day.', action: ui.button('Back to help', { onClick: () => nav('help') }) }));
        } catch (err) {
          send.disabled = false;
          const notYet = err.status === 404 || err.code === 'no_api';
          status.append(h('div', { class: 'help-error' }, ui.icon('alert', 18), h('div', null,
            h('strong', null, notYet ? 'Messages from the app are not switched on yet.' : "Your message wasn't sent."),
            h('div', null, notYet ? 'Email us instead: ' : `${err.message} You can also email `, h('a', { href: `mailto:${supportEmail}?subject=${encodeURIComponent(subject.value.trim())}` }, supportEmail), '.'))));
        }
      } },
      h('label', { class: 'field' }, h('span', null, 'Subject *'), subject),
      h('label', { class: 'field' }, h('span', null, 'Message *'), message),
      h('div', { class: 'row help-shot' }, pick, shotName),
      h('p', { class: 'muted help-note' }, `We'll see your name, company and the screen you came from${lastPage ? ` (${lastPage})` : ''}. Don't include passwords or card numbers.`),
      status,
      h('div', { class: 'row' }, ui.button('Cancel', { variant: 'ghost', onClick: () => nav('help') }), h('span', { class: 'grow' }), send));
      ui.clear(body);
      body.append(form);
      setTimeout(() => subject.focus(), 30);
    }

    if (view === 'contact') contact();
    else if (view === 'article') article(params[0]);
    else index();
    return () => { alive = false; };
  },
};
