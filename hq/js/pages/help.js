// Help center: the articles companies read in the app (#/help there). Write in Markdown with
// a live preview (the app's own safe renderer), file under a category, save as a draft or
// publish. HQ staff write and edit drafts; HQ admins publish, unpublish, delete and manage
// categories. Drafts never reach companies.
import { renderMarkdown } from '/js/lib/markdown.js';
import { del, get, patch, post, put } from '../api.js';
import { ago } from '../fmt.js';
import { loader } from '../kit.js';

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    let data = null;
    let hits = null;
    let term = '';
    const listHost = h('div', { class: 'stack' });
    const search = ui.searchBox('Search articles (Enter)', (v) => { term = v; if (!v.trim()) { hits = null; draw(); } });
    search.querySelector('input').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !term.trim()) return;
      try { hits = (await post('/api/hq/help/search', { q: term.trim() })).data; draw(); } catch (err) { ui.toast(err.message, 'error'); }
    });
    root.append(ui.page({
      title: 'Help center', subtitle: 'Articles companies read in the app',
      actions: [isAdmin ? ui.button('Categories', { size: 'sm', icon: 'list', onClick: categories }) : null, ui.button('New article', { variant: 'primary', icon: 'plus', onClick: () => edit(null) })].filter(Boolean),
    }, h('div', { class: 'hq-toolbar' }, h('span', { class: 'grow' }), search), listHost));

    const row = (a) => h('div', { class: 'list-row click', tabindex: 0, onClick: () => edit(a), onKeydown: (e) => { if (e.key === 'Enter') edit(a); } },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'meta' }, a.snippet || a.summary || `/${a.slug}`)),
      ui.badge(a.status, a.status === 'published' ? 'success' : 'neutral'), h('span', { class: 'muted hq-small' }, ago(a.updatedAt)));

    function draw() {
      ui.clear(listHost);
      if (hits) {
        listHost.append(h('p', { class: 'muted hq-small' }, `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${term.trim()}" (drafts included)`),
          hits.length ? h('div', { class: 'list' }, hits.map(row)) : null);
        return;
      }
      const groups = [...data.categories.map((c) => ({ ...c, items: data.data.filter((a) => a.categoryId === c.id) })), { id: null, name: 'No category', items: data.data.filter((a) => !a.categoryId) }];
      const drafts = data.data.filter((a) => a.status === 'draft').length;
      listHost.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'Published', value: data.data.length - drafts }), ui.stat({ label: 'Drafts', value: drafts, hint: 'Only HQ sees drafts' }), ui.stat({ label: 'Categories', value: data.categories.length })));
      for (const g of groups) {
        if (!g.items.length && g.id === null) continue;
        listHost.append(...ui.section(g.name, g.items.length ? h('div', { class: 'list' }, g.items.map(row)) : h('div', { class: 'card flat muted' }, 'No articles in this category.')));
      }
    }

    async function edit(stub) {
      let a = stub ? await get(`/api/hq/help/articles/${stub.id}`).catch((e) => { ui.toast(e.message, 'error'); return null; }) : null;
      if (stub && !a) return;
      a ||= { title: '', slug: '', summary: '', body: '', categoryId: data.categories[0]?.id || null, status: 'draft' };
      const locked = a.status === 'published' && !isAdmin;
      const preview = h('div', { class: 'help-article hq-md-preview' });
      const title = h('input', { name: 'title', value: a.title, required: true, disabled: locked });
      const slug = h('input', { name: 'slug', value: a.slug, placeholder: 'from the title', pattern: '[a-z0-9][a-z0-9-]{1,79}', disabled: locked });
      const summary = h('input', { name: 'summary', value: a.summary, maxlength: 300, disabled: locked });
      const category = h('select', { name: 'categoryId', disabled: locked }, h('option', { value: '' }, 'No category'), data.categories.map((c) => h('option', { value: c.id, selected: c.id === a.categoryId }, c.name)));
      const text = h('textarea', { name: 'body', class: 'hq-md-input mono', rows: 22, disabled: locked, spellcheck: 'true' }, a.body);
      const paint = () => {
        // renderMarkdown escapes every piece of text and emits only a fixed set of tags and safe URLs.
        preview.innerHTML = renderMarkdown(`# ${title.value || 'Title'}\n\n${text.value}`, { origin: location.origin });
      };
      text.addEventListener('input', paint);
      title.addEventListener('input', paint);
      paint();
      const save = async (status) => {
        if (!title.value.trim()) { ui.toast('Give it a title', 'error'); return; }
        const payload = { title: title.value.trim(), summary: summary.value.trim(), body: text.value, categoryId: category.value || null, ...(slug.value.trim() ? { slug: slug.value.trim() } : {}), ...(status ? { status } : {}) };
        try {
          const r = a.id ? await patch(`/api/hq/help/articles/${a.id}`, payload) : await post('/api/hq/help/articles', payload);
          ui.toast(r.status === 'published' ? 'Published: companies see it now' : 'Saved as a draft', 'success');
          s.close();
          load();
        } catch (e) { ui.toast(e.message, 'error', 5000); }
      };
      const actions = [
        a.id && isAdmin ? ui.button('Delete', { variant: 'ghost danger', onClick: async () => {
          if (!(await ui.confirmDialog(`"${a.title}" is deleted for everyone.`, { title: 'Delete the article?', okLabel: 'Delete' }))) return;
          try { await del(`/api/hq/help/articles/${a.id}`); ui.toast('Deleted', 'success'); s.close(); load(); } catch (e) { ui.toast(e.message, 'error'); }
        } }) : null,
        h('span', { class: 'grow' }),
        ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
        locked ? null : ui.button(a.status === 'published' ? 'Save changes' : 'Save draft', { onClick: () => save() }),
        isAdmin && a.status === 'published' ? ui.button('Unpublish', { onClick: () => save('draft') }) : null,
        isAdmin && a.status !== 'published' ? ui.button('Publish', { variant: 'primary', onClick: () => save('published') }) : null,
      ].filter(Boolean);
      const s = ui.openSheet({
        title: a.id ? a.title : 'New article', wide: true, actions,
        body: h('div', { class: 'stack' },
          locked ? h('p', { class: 'hq-banner degraded' }, 'Published. An HQ admin edits published articles or unpublishes this one so you can.') : null,
          h('div', { class: 'form-grid' },
            h('label', { class: 'field span-2' }, h('span', null, 'Title *'), title),
            h('label', { class: 'field' }, h('span', null, 'Address (slug)'), slug, h('span', { class: 'hint' }, a.slug ? `#/help/${a.slug} in the app` : 'Made from the title')),
            h('label', { class: 'field' }, h('span', null, 'Category'), category),
            h('label', { class: 'field span-2' }, h('span', null, 'Summary (shown in lists and search)'), summary)),
          h('div', { class: 'hq-md-editor' },
            h('label', { class: 'field' }, h('span', null, 'Markdown'), text, h('span', { class: 'hint' }, '## heading, **bold**, - list, 1. steps, [link](#/drawings), | tables |. No HTML.')),
            h('div', { class: 'field' }, h('span', null, 'Preview, as companies see it'), preview))),
      });
    }

    function categories() {
      const host = h('div', { class: 'stack' });
      const drawCats = () => {
        ui.clear(host);
        host.append(h('div', { class: 'list' }, data.categories.map((c) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, c.name), h('div', { class: 'meta' }, `${c.id} · ${c.articles} articles · order ${c.position}`)),
          ui.button('', { icon: 'edit', title: `Edit ${c.name}`, size: 'sm', onClick: () => catForm(c) }),
          ui.button('', { icon: 'trash', title: `Delete ${c.name}`, size: 'sm', variant: 'ghost danger', onClick: async () => {
            if (!(await ui.confirmDialog(`Its ${c.articles} articles stay, without a category.`, { title: `Delete ${c.name}?`, okLabel: 'Delete' }))) return;
            try { await del(`/api/hq/help/categories/${c.id}`); await reload(); } catch (e) { ui.toast(e.message, 'error'); }
          } })))), ui.button('Add category', { icon: 'plus', onClick: () => catForm(null) }));
      };
      const reload = async () => { data = await get('/api/hq/help'); drawCats(); draw(); };
      const catForm = (c) => ui.formSheet({
        title: c ? `Category: ${c.name}` : 'New category',
        fields: [
          { label: 'Id (a-z, 0-9, -)', name: 'id', value: c?.id || '', required: true, readonly: Boolean(c) },
          { label: 'Name', name: 'name', value: c?.name || '', required: true },
          { label: 'Description', name: 'description', value: c?.description || '', span: true },
          { label: 'Order', name: 'position', type: 'number', value: c?.position ?? (data.categories.length + 1) * 10 },
        ],
        onSubmit: (v) => {
          if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id)) { ui.toast('Id: lowercase letters, digits and dashes', 'error'); return false; }
          put(`/api/hq/help/categories/${v.id}`, { name: v.name.trim(), description: v.description.trim(), position: v.position ?? 0 }).then(reload).catch((e) => ui.toast(e.message, 'error'));
        },
      });
      ui.openSheet({ title: 'Help categories', body: host });
      drawCats();
    }

    const load = () => loader(ui, listHost, async () => { data = await get('/api/hq/help'); hits = null; draw(); });
    load();
    return () => {};
  },
};
