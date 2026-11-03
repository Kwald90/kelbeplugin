// Marketing hub: edit the sell-side pieces (the catalog and co-branded editions) and run the
// tracked trial links. The editor rearranges a block model — cover, feature grids and a
// call-to-action — with up/down controls (reliable on the iPad, where native drag does not fire)
// and desktop drag-and-drop. Campaign links carry a trial length and show their funnel.
import { get, post, put, del } from '../api.js';
import { card, loader } from '../kit.js';

const KIND_LABEL = { catalog: 'Catalog', flyer: 'Flyer', onepager: 'One-pager', email: 'Email' };
const SECTION_LABEL = { cover: 'Cover', features: 'Feature page', cta: 'Call to action' };
const rid = () => `b${(globalThis.crypto?.randomUUID?.() || Math.random().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 8)}`;

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Marketing', subtitle: 'The catalog and co-branded pieces, and the tracked trial links — all here' }, body));
    let state = { pieces: [], campaigns: [], plans: [] };
    loadList();

    // ---- list view ------------------------------------------------------------------------
    async function loadList() {
      await loader(ui, body, async () => {
        state = await get('/api/hq/marketing');
        ui.clear(body);
        body.append(piecesCard(), campaignsCard());
      });
    }

    function piecesCard() {
      const rows = state.pieces.map((p) => h('div', { class: 'hq-mk-row' },
        h('div', { class: 'grow' },
          h('strong', null, p.title), ' ', ui.badge(p.status, p.status === 'published' ? 'success' : 'neutral'),
          h('div', { class: 'hq-small muted' }, `${KIND_LABEL[p.kind] || p.kind} · /site/piece.html?slug=${p.slug}`)),
        h('div', { class: 'row' },
          h('a', { class: 'btn ghost', href: `/site/piece.html?slug=${encodeURIComponent(p.slug)}`, target: '_blank', rel: 'noopener' }, 'View'),
          ui.button('Edit', { onClick: () => openEditor(p.id) }),
          isAdmin && p.slug !== 'catalog' ? ui.button('', { variant: 'ghost', icon: 'trash', title: 'Delete', onClick: () => removePiece(p) }) : null)));
      const actions = isAdmin ? [ui.button('New piece', { variant: 'primary', icon: 'plus', onClick: newPiece })] : [];
      return card(ui, 'Pieces', 'book', h('div', { class: 'stack' }, rows.length ? rows : h('p', { class: 'muted' }, 'No pieces yet.'), actions.length ? h('div', { class: 'row' }, ...actions) : null));
    }

    function campaignsCard() {
      const head = h('div', { class: 'hq-mk-crow hq-mk-chead' },
        ...['Link', 'Trial', 'Visits', 'Starts', 'Signed up', ''].map((t) => h('span', null, t)));
      const rows = state.campaigns.map((c) => {
        const conv = c.visits ? `${Math.round((c.completed / c.visits) * 100)}%` : '—';
        return h('div', { class: ['hq-mk-crow', c.active ? null : 'off'] },
          h('div', null, h('strong', null, c.label),
            h('div', { class: 'hq-small muted mono' }, c.code), c.active ? null : ui.badge('off', 'neutral'),
            c.pieceSlug ? h('div', { class: 'hq-small muted' }, `→ ${c.pieceSlug}`) : null),
          h('span', null, `${c.trialDays}d`, c.plan ? h('div', { class: 'hq-small muted' }, c.plan) : null),
          h('span', null, String(c.visits)),
          h('span', null, String(c.starts)),
          h('span', null, String(c.completed), h('div', { class: 'hq-small muted' }, `conv ${conv}`)),
          h('div', { class: 'row' },
            ui.button('Copy link', { icon: 'link', onClick: () => copyLink(c) }),
            isAdmin ? ui.button('', { variant: 'ghost', icon: 'pencil', title: 'Edit', onClick: () => editCampaign(c) }) : null,
            isAdmin ? ui.button('', { variant: 'ghost', icon: 'trash', title: 'Delete', onClick: () => removeCampaign(c) }) : null));
      });
      const actions = isAdmin ? [ui.button('New tracked link', { variant: 'primary', icon: 'plus', onClick: () => editCampaign(null) })] : [];
      return card(ui, 'Tracked trial links', 'link',
        h('p', { class: 'muted hq-small' }, 'Each link sets its own free-trial length and shows how many people landed, started a sign-up and became a company.'),
        h('div', { class: 'hq-mk-ctable' }, head, ...(rows.length ? rows : [h('p', { class: 'muted' }, 'No links yet.')])),
        actions.length ? h('div', { class: 'row' }, ...actions) : null);
    }

    function trackedLink(c) {
      const base = location.origin;
      return c.pieceSlug ? `${base}/site/piece.html?slug=${c.pieceSlug}&code=${c.code}` : `${base}/site/signup.html?code=${c.code}`;
    }
    async function copyLink(c) {
      const link = trackedLink(c);
      try { await navigator.clipboard.writeText(link); ui.toast('Link copied', 'success'); }
      catch { await ui.promptDialog('Copy this link:', { title: c.label, value: link, okLabel: 'Done' }); }
    }

    // ---- create / edit campaigns & pieces -------------------------------------------------
    function newPiece() {
      ui.formSheet({
        title: 'New piece',
        fields: [
          { name: 'title', label: 'Title', required: true, placeholder: 'EECOL co-brand catalog' },
          { name: 'slug', label: 'URL slug', required: true, hint: 'lower-case, dashes', placeholder: 'eecol-catalog' },
          { name: 'kind', label: 'Kind', type: 'select', options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
        ],
        submitLabel: 'Create',
        onSubmit: (v) => { createPiece(v); },
      });
    }
    async function createPiece(v) {
      try {
        const { piece } = await post('/api/hq/marketing/pieces', { title: v.title.trim(), slug: v.slug.trim().toLowerCase(), kind: v.kind || 'catalog' });
        ui.toast('Piece created', 'success');
        openEditor(piece.id);
      } catch (e) { ui.toast(e.message, 'error', 6000); }
    }
    async function removePiece(p) {
      if (!(await ui.confirmDialog(`Delete “${p.title}”? This cannot be undone.`, { title: 'Delete piece?', okLabel: 'Delete', danger: true }))) return;
      try { await del(`/api/hq/marketing/pieces/${p.id}`); ui.toast('Deleted', 'success'); loadList(); }
      catch (e) { ui.toast(e.message, 'error', 6000); }
    }

    function editCampaign(c) {
      const pieceOpts = [{ value: '', label: '— signup page —' }, ...state.pieces.map((p) => ({ value: p.id, label: p.title }))];
      const planOpts = [{ value: '', label: 'Let them choose' }, ...state.plans.map((p) => ({ value: p, label: p }))];
      ui.formSheet({
        title: c ? `Edit ${c.code}` : 'New tracked link',
        fields: [
          { name: 'code', label: 'Code', required: true, readonly: !!c, value: c?.code || '', hint: 'in the link; lower-case, dashes/underscores', placeholder: 'eecol-wpg' },
          { name: 'label', label: 'Name', required: true, value: c?.label || '', placeholder: 'EECOL Winnipeg counter' },
          { name: 'trialDays', label: 'Trial days', type: 'number', required: true, min: 1, max: 730, value: c?.trialDays ?? 75 },
          { name: 'plan', label: 'Pre-pick plan', type: 'select', value: c?.plan || '', options: planOpts },
          { name: 'pieceId', label: 'Opens', type: 'select', value: c?.pieceId || '', options: pieceOpts },
          { name: 'active', label: 'Active', type: 'checkbox', value: c ? c.active : true },
        ],
        submitLabel: 'Save',
        onSubmit: (v) => { saveCampaign(c, v); },
      });
    }
    async function saveCampaign(existing, v) {
      const code = (existing?.code || v.code || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) { ui.toast('Code: lower-case letters, numbers, dashes or underscores', 'error', 5000); return false; }
      try {
        const { campaigns } = await put(`/api/hq/marketing/campaigns/${encodeURIComponent(code)}`, {
          label: v.label.trim(), trialDays: Number(v.trialDays) || 75,
          plan: v.plan || null, pieceId: v.pieceId || null, active: !!v.active,
        });
        state.campaigns = campaigns;
        ui.clear(body); body.append(piecesCard(), campaignsCard());
        ui.toast('Link saved', 'success');
      } catch (e) { ui.toast(e.message, 'error', 6000); return false; }
    }
    async function removeCampaign(c) {
      if (!(await ui.confirmDialog(`Delete the link “${c.label}” (${c.code})? The printed/shared link will stop working.`, { title: 'Delete link?', okLabel: 'Delete', danger: true }))) return;
      try { await del(`/api/hq/marketing/campaigns/${encodeURIComponent(c.code)}`); ui.toast('Deleted', 'success'); loadList(); }
      catch (e) { ui.toast(e.message, 'error', 6000); }
    }

    // ---- editor ---------------------------------------------------------------------------
    async function openEditor(pieceId) {
      await loader(ui, body, async () => {
        const { piece } = await get(`/api/hq/marketing/pieces/${pieceId}`);
        piece.content = piece.content || { sections: [] };
        piece.content.sections = piece.content.sections || [];
        piece.cobrand = piece.cobrand || { enabled: false, partner: '', tagline: '', accent: '' };
        ui.clear(body);
        new Editor(piece).mount(body);
      });
    }

    class Editor {
      constructor(piece) { this.p = piece; this.dirty = false; this.canEdit = isAdmin; }
      mount(host) {
        this.host = host;
        this.secHost = h('div', { class: 'hq-mk-editor' });
        this.saveBtn = ui.button('Save', { variant: 'primary', icon: 'check', onClick: () => this.save() });
        host.append(this.toolbar(), this.cobrandCard(), this.secHost, this.addBar());
        this.renderSections();
        this.updateSave();
      }
      markDirty() { this.dirty = true; this.updateSave(); }
      updateSave() { this.saveBtn.disabled = !this.dirty || !this.canEdit; this.saveBtn.textContent = this.dirty ? 'Save changes' : 'Saved'; }

      toolbar() {
        const title = h('input', { class: 'input hq-mk-title', value: this.p.title, readonly: !this.canEdit, onInput: (e) => { this.p.title = e.target.value; this.markDirty(); } });
        const status = h('select', { class: 'input', disabled: !this.canEdit, onChange: (e) => { this.p.status = e.target.value; this.markDirty(); } },
          h('option', { value: 'draft', selected: this.p.status !== 'published' }, 'Draft'),
          h('option', { value: 'published', selected: this.p.status === 'published' }, 'Published'));
        return h('div', { class: 'hq-mk-toolbar' },
          ui.button('', { variant: 'ghost', icon: 'chevron-left', title: 'Back', onClick: () => this.back() }),
          title,
          h('label', { class: 'field hq-filter' }, h('span', null, 'Status'), status),
          h('a', { class: 'btn ghost', href: `/site/piece.html?slug=${encodeURIComponent(this.p.slug)}`, target: '_blank', rel: 'noopener' }, 'Preview'),
          this.saveBtn);
      }
      async back() {
        if (this.dirty && !(await ui.confirmDialog('Leave without saving your changes?', { title: 'Unsaved changes', okLabel: 'Leave', danger: true }))) return;
        loadList();
      }

      cobrandCard() {
        const cb = this.p.cobrand;
        const on = h('input', { type: 'checkbox', checked: !!cb.enabled, disabled: !this.canEdit, onChange: (e) => { cb.enabled = e.target.checked; this.markDirty(); } });
        const partner = h('input', { class: 'input', value: cb.partner || '', placeholder: 'Wholesaler / partner name', readonly: !this.canEdit, onInput: (e) => { cb.partner = e.target.value; this.markDirty(); } });
        const tagline = h('input', { class: 'input', value: cb.tagline || '', placeholder: 'Short tagline', readonly: !this.canEdit, onInput: (e) => { cb.tagline = e.target.value; this.markDirty(); } });
        const accent = h('input', { type: 'color', class: 'hq-mk-color', value: /^#[0-9a-f]{6}$/i.test(cb.accent || '') ? cb.accent : '#1f6feb', disabled: !this.canEdit, onInput: (e) => { cb.accent = e.target.value; this.markDirty(); } });
        return card(ui, 'Co-brand', 'palette',
          h('p', { class: 'muted hq-small' }, 'Turn on to show a partner name, tagline and accent colour on the published page — one piece, a branded edition per partner.'),
          h('label', { class: 'field check' }, on, h('span', null, 'Co-brand this piece')),
          h('div', { class: 'hq-mk-cobrand' },
            h('label', { class: 'field' }, h('span', null, 'Partner'), partner),
            h('label', { class: 'field' }, h('span', null, 'Tagline'), tagline),
            h('label', { class: 'field' }, h('span', null, 'Accent'), accent)));
      }

      addBar() {
        if (!this.canEdit) return null;
        return h('div', { class: 'hq-mk-addbar' },
          ui.button('Add feature page', { icon: 'plus', onClick: () => this.addSection('features') }),
          ui.button('Add cover', { icon: 'plus', onClick: () => this.addSection('cover') }),
          ui.button('Add call-to-action', { icon: 'plus', onClick: () => this.addSection('cta') }));
      }
      addSection(kind) {
        const s = kind === 'cover' ? { id: rid(), kind, title: '', subtitle: '', footnote: '' }
          : kind === 'cta' ? { id: rid(), kind, heading: '', body: '', footnote: '' }
            : { id: rid(), kind: 'features', heading: '', intro: '', cards: [] };
        this.p.content.sections.push(s);
        this.markDirty(); this.renderSections();
      }

      move(arr, i, dir) { const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; this.markDirty(); this.renderSections(); }

      renderSections() {
        const secs = this.p.content.sections;
        ui.clear(this.secHost);
        if (!secs.length) { this.secHost.append(h('p', { class: 'muted' }, 'No sections yet. Add one below.')); return; }
        secs.forEach((s, i) => this.secHost.append(this.sectionCard(s, i, secs)));
      }

      sectionCard(s, i, secs) {
        const head = h('div', { class: 'hq-mk-sechead' },
          h('span', { class: 'hq-mk-grip', title: 'Drag to reorder' }, '⠿'),
          h('strong', null, SECTION_LABEL[s.kind] || s.kind),
          h('span', { class: 'grow' }),
          this.canEdit ? ui.button('', { variant: 'ghost', icon: 'chevron-up', title: 'Move up', onClick: () => this.move(secs, i, -1) }) : null,
          this.canEdit ? ui.button('', { variant: 'ghost', icon: 'chevron-down', title: 'Move down', onClick: () => this.move(secs, i, 1) }) : null,
          this.canEdit ? ui.button('', { variant: 'ghost', icon: 'trash', title: 'Delete section', onClick: () => { secs.splice(i, 1); this.markDirty(); this.renderSections(); } }) : null);
        const node = h('div', { class: 'hq-mk-sec', draggable: this.canEdit ? 'true' : null }, head, this.sectionBody(s));
        if (this.canEdit) this.wireDrag(node, secs, i);
        return node;
      }

      sectionBody(s) {
        const ta = (val, placeholder, set, rows = 2) => h('textarea', { class: 'input', rows, placeholder, readonly: !this.canEdit, onInput: (e) => { set(e.target.value); this.markDirty(); } }, val || '');
        const inp = (val, placeholder, set) => h('input', { class: 'input', value: val || '', placeholder, readonly: !this.canEdit, onInput: (e) => { set(e.target.value); this.markDirty(); } });
        if (s.kind === 'cover') {
          return h('div', { class: 'stack' },
            labelled(ui, 'Title', inp(s.title, 'Headline', (v) => { s.title = v; })),
            labelled(ui, 'Subtitle', ta(s.subtitle, 'Supporting line', (v) => { s.subtitle = v; })),
            labelled(ui, 'Footnote', inp(s.footnote, 'Small print', (v) => { s.footnote = v; })));
        }
        if (s.kind === 'cta') {
          return h('div', { class: 'stack' },
            labelled(ui, 'Heading', inp(s.heading, 'Call to action', (v) => { s.heading = v; })),
            labelled(ui, 'Body', ta(s.body, 'What to do next', (v) => { s.body = v; })),
            labelled(ui, 'Footnote', inp(s.footnote, 'Small print', (v) => { s.footnote = v; })));
        }
        // features
        s.cards = s.cards || [];
        const cardsHost = h('div', { class: 'hq-mk-cards' });
        const drawCards = () => {
          ui.clear(cardsHost);
          s.cards.forEach((cd, ci) => cardsHost.append(h('div', { class: 'hq-mk-cardedit' },
            h('div', { class: 'row' },
              inp(cd.title, 'Card title', (v) => { cd.title = v; }),
              this.canEdit ? ui.button('', { variant: 'ghost', icon: 'chevron-up', title: 'Up', onClick: () => { if (ci > 0) { [s.cards[ci - 1], s.cards[ci]] = [s.cards[ci], s.cards[ci - 1]]; this.markDirty(); drawCards(); } } }) : null,
              this.canEdit ? ui.button('', { variant: 'ghost', icon: 'chevron-down', title: 'Down', onClick: () => { if (ci < s.cards.length - 1) { [s.cards[ci + 1], s.cards[ci]] = [s.cards[ci], s.cards[ci + 1]]; this.markDirty(); drawCards(); } } }) : null,
              this.canEdit ? ui.button('', { variant: 'ghost', icon: 'trash', title: 'Delete card', onClick: () => { s.cards.splice(ci, 1); this.markDirty(); drawCards(); } }) : null),
            ta(cd.body, 'Card text', (v) => { cd.body = v; }))));
          if (this.canEdit) cardsHost.append(ui.button('Add card', { icon: 'plus', onClick: () => { s.cards.push({ id: rid(), title: '', body: '' }); this.markDirty(); drawCards(); } }));
        };
        drawCards();
        return h('div', { class: 'stack' },
          labelled(ui, 'Heading', inp(s.heading, 'Section heading', (v) => { s.heading = v; })),
          labelled(ui, 'Intro', ta(s.intro, 'Optional intro line', (v) => { s.intro = v; })),
          cardsHost);
      }

      wireDrag(node, secs, i) {
        node.addEventListener('dragstart', (e) => {
          if (e.target.closest('input,textarea,select,button')) { e.preventDefault(); return; }
          this.from = i; e.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging');
        });
        node.addEventListener('dragend', () => node.classList.remove('dragging'));
        node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop-over'); });
        node.addEventListener('dragleave', () => node.classList.remove('drop-over'));
        node.addEventListener('drop', (e) => {
          e.preventDefault(); node.classList.remove('drop-over');
          if (this.from == null || this.from === i) return;
          const [moved] = secs.splice(this.from, 1); secs.splice(i, 0, moved);
          this.from = null; this.markDirty(); this.renderSections();
        });
      }

      async save() {
        if (!this.canEdit) return;
        try {
          const { piece } = await put(`/api/hq/marketing/pieces/${this.p.id}`, {
            title: this.p.title, status: this.p.status, content: this.p.content, cobrand: this.p.cobrand,
          });
          this.p = piece; this.p.content = piece.content || { sections: [] }; this.p.cobrand = piece.cobrand || {};
          this.dirty = false; this.updateSave();
          ui.toast('Saved' + (piece.status === 'published' ? ' & published' : ''), 'success');
        } catch (e) { ui.toast(e.message, 'error', 6000); }
      }
    }

    return () => {};
  },
};

// A labelled control row (local copy of kit.labelled but without the toolbar class, for the editor).
function labelled(ui, label, control) {
  return ui.h('label', { class: 'field hq-mk-field' }, ui.h('span', null, label), control);
}
