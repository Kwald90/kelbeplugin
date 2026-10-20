// Promotions: the landing page's video hero (site/index.html). List, edit with a live preview
// (the real player from /site/hero.js, desktop and phone), duplicate, schedule, deactivate,
// and the media library (uploads to /api/hq/media, served at /media/). HQ admins only.
//   #/promotions          list + media library
//   #/promotions/new      new promotion (starts from the built-in default)
//   #/promotions/<id>     edit
import { get, post, put, del, ApiError } from '../api.js';
import { ago, bytes } from '../fmt.js';
import { createHero } from '/site/hero.js';

const STATE_TONE = { live: 'success', scheduled: 'info', draft: 'neutral', inactive: 'neutral', ended: 'warning' };
const TEXT = [['eyebrow', 'Eyebrow', 60], ['headline', 'Headline', 120], ['subline', 'Sub-line', 240], ['note', 'Fine print', 160]];
const SLIDE_MEDIA = [
  ['videoDesktop', 'Desktop video (16:9 MP4)', 'video'], ['videoMobile', 'Phone video (9:16 or 4:5 MP4)', 'video'],
  ['poster', 'Poster (JPG/WebP, first frame)', 'image'], ['posterMobile', 'Phone poster (optional)', 'image'],
  ['webmDesktop', 'Desktop WebM (optional)', 'webm'], ['webmMobile', 'Phone WebM (optional)', 'webm'],
];

/** The hero's own styles (shared with the landing page) and this page's. */
function ensureCss() {
  for (const href of ['/site/hero.css', '/hq/promotions.css']) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.append(l);
  }
}

const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (v) => (v ? new Date(v).toISOString() : null);
const clone = (o) => JSON.parse(JSON.stringify(o));
const errorText = (e) => (e instanceof ApiError && e.details?.errors?.length
  ? `${e.message} ${e.details.errors.map((x) => `${x.path.replace(/^\//, '').replaceAll('/', ' › ')} ${x.message}`).join('; ')}`
  : e.message);

/** Upload one file as the raw body, with progress. Resolves to the media record. */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/hq/media');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Fishtape', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Media-Label', encodeURIComponent(file.name.slice(0, 200)));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      if (xhr.status === 201) resolve(body);
      else reject(new ApiError(xhr.status, body?.error || { message: xhr.status === 413 ? 'That file is too large for the server or the proxy.' : `Upload failed (${xhr.status}).` }));
    };
    xhr.onerror = () => reject(new ApiError(0, { code: 'offline', message: 'Upload failed: cannot reach the server.' }));
    xhr.send(file);
  });
}

export default {
  render(root, { ui, params, nav, isAdmin }) {
    const { h } = ui;
    ensureCss();
    const cleanups = [];
    if (!isAdmin) {
      root.append(ui.page({ title: 'Promotions', subtitle: 'The landing page hero' }, ui.empty({ icon: 'lock', title: 'HQ admins only', text: 'Ask an HQ admin to change the landing page promotions.' })));
      return () => {};
    }
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const id = params[0];
    root.append(ui.page({
      title: id ? (id === 'new' ? 'New promotion' : 'Edit promotion') : 'Promotions',
      subtitle: 'The video hero on the landing page: text, buttons, clips and when it runs',
      actions: id ? [ui.button('All promotions', { icon: 'chevron-left', onClick: () => nav('promotions') })] : [ui.button('New promotion', { icon: 'plus', variant: 'primary', onClick: () => nav('promotions/new') })],
    }, body));

    let list = null, media = [];
    async function loadAll() {
      [list, media] = await Promise.all([get('/api/hq/promotions'), get('/api/hq/media').then((r) => r.data)]);
    }

    // ---------------- list ----------------
    function drawList() {
      ui.clear(body);
      const serving = list.data.find((p) => p.serving);
      body.append(h('div', { class: ['hq-banner', serving ? 'ok' : null] }, ui.icon(serving ? 'play' : 'info', 20),
        h('div', null, h('strong', null, serving ? `Serving now: ${serving.name}` : 'Serving now: the built-in default'),
          h('span', { class: 'hq-small' }, serving ? `Since ${serving.startsAt ? ui.fmtDateTime(serving.startsAt) : 'it was activated'}${serving.endsAt ? `, until ${ui.fmtDateTime(serving.endsAt)}` : ''}. Visitors with an audience tag may see a targeted one.`
            : 'No promotion is live, so visitors see "Built for Canadian electricians" with poster slides.'))));
      body.append(ui.table({
        columns: [
          { key: 'name', label: 'Promotion', render: (p) => h('div', null, h('strong', null, p.name), h('div', { class: 'muted hq-small' }, p.overlay?.headline || '')) },
          { key: 'state', label: 'State', render: (p) => h('div', { class: 'hq-pill-list' }, ui.badge(p.state, STATE_TONE[p.state]), p.serving ? ui.badge('serving', 'accent') : null) },
          { key: 'window', label: 'Runs', render: (p) => `${p.startsAt ? ui.fmtDate(p.startsAt) : 'now'} → ${p.endsAt ? ui.fmtDate(p.endsAt) : 'no end'}` },
          { key: 'priority', label: 'Priority', align: 'right', render: (p) => String(p.priority) },
          { key: 'audience', label: 'Audience', render: (p) => (p.audience ? h('span', { class: 'mono' }, p.audience) : 'Everyone') },
          { key: 'updated', label: 'Changed', render: (p) => `${ago(p.updatedAt)}${p.updatedByName ? ` · ${p.updatedByName}` : ''}` },
          { key: 'actions', label: '', render: (p) => h('div', { class: 'row', onClick: (e) => e.stopPropagation() },
            ui.button('', { icon: 'copy', size: 'sm', title: `Duplicate ${p.name}`, onClick: () => duplicate(p) }),
            p.status === 'active'
              ? ui.button('Deactivate', { size: 'sm', onClick: () => setStatus(p, 'inactive') })
              : ui.button('Activate', { size: 'sm', onClick: () => setStatus(p, 'active') })) },
        ],
        rows: list.data,
        onRowClick: (p) => nav(`promotions/${p.id}`),
        empty: ui.empty({ icon: 'play', title: 'No promotions yet', text: 'The landing page shows the built-in default until you make one.', action: ui.button('New promotion', { variant: 'primary', icon: 'plus', onClick: () => nav('promotions/new') }) }),
      }));
      body.append(...ui.section('Media library', mediaLibrary()));
    }

    async function duplicate(p) {
      try { const r = await post(`/api/hq/promotions/${p.id}/duplicate`); ui.toast('Copied as a draft', 'success'); nav(`promotions/${r.id}`); } catch (e) { ui.toast(errorText(e), 'error', 5000); }
    }
    async function setStatus(p, status) {
      try { await post(`/api/hq/promotions/${p.id}/status`, { status }); ui.toast(status === 'active' ? 'Activated' : 'Deactivated', 'success'); await loadAll(); drawList(); } catch (e) { ui.toast(errorText(e), 'error', 5000); }
    }

    // ---------------- media library ----------------
    function mediaLibrary(onPick) {
      const box = h('div', { class: 'stack' });
      const status = h('p', { class: 'muted hq-small', role: 'status' });
      const input = h('input', { type: 'file', accept: 'video/mp4,video/webm,image/jpeg,image/png,image/webp', multiple: true, class: 'hq-file', name: 'media', 'aria-label': 'Upload videos or posters' });
      input.addEventListener('change', async () => {
        const files = [...input.files];
        input.value = '';
        for (const f of files) {
          try {
            const m = await uploadFile(f, (p) => { status.textContent = `Uploading ${f.name}: ${Math.round(p * 100)}%`; });
            media.unshift(m);
            status.textContent = `Uploaded ${f.name} → ${m.url}`;
            ui.toast(`Uploaded ${f.name}`, 'success');
          } catch (e) { status.textContent = ''; ui.toast(`${f.name}: ${errorText(e)}`, 'error', 6000); }
        }
        draw();
      });
      const up = list?.uploads;
      function draw() {
        ui.clear(box);
        box.append(h('div', { class: 'row' },
          up && !up.enabled ? h('p', { class: 'hq-error' }, up.problem) : h('label', { class: 'btn primary' }, ui.icon('upload', 18), h('span', null, 'Upload videos or posters'), input),
          h('span', { class: 'muted hq-small' }, up ? `MP4 or WebM up to ${bytes(up.maxVideoBytes)}; JPG, PNG or WebP up to ${bytes(up.maxImageBytes)}. Checked by content; files get random names.` : '')), status);
        if (!media.length) { box.append(h('p', { class: 'muted' }, 'Nothing uploaded yet.')); return; }
        box.append(h('div', { class: 'hq-media-grid' }, media.map((m) => h('figure', { class: 'card flat hq-media' },
          m.kind === 'image' ? h('img', { src: m.url, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'hq-media-video' }, ui.icon('play', 28), h('span', null, m.type.replace('video/', '').toUpperCase())),
          h('figcaption', null,
            h('div', { class: 'title' }, m.label || m.name),
            h('div', { class: 'muted hq-small mono' }, m.url),
            h('div', { class: 'muted hq-small' }, `${bytes(m.bytes)} · ${ago(m.createdAt)}`),
            h('div', { class: 'row' },
              onPick ? ui.button('Use', { size: 'sm', onClick: () => onPick(m) }) : null,
              ui.button('', { size: 'sm', icon: 'copy', title: `Copy ${m.url}`, onClick: () => navigator.clipboard?.writeText(m.url).then(() => ui.toast('Copied', 'success')) }),
              ui.button('', { size: 'sm', icon: 'trash', variant: 'ghost danger', title: `Delete ${m.label || m.name}`, onClick: async () => {
                if (!(await ui.confirmDialog(`Delete ${m.label || m.name}? Pages using it will fall back to the poster.`, { okLabel: 'Delete' }))) return;
                try { await del(`/api/hq/media/${m.name}`); media = media.filter((x) => x !== m); draw(); } catch (e) { ui.toast(errorText(e), 'error', 6000); }
              } })))))));
      }
      draw();
      return box;
    }

    // ---------------- editor ----------------
    function drawEditor(p) {
      ui.clear(body);
      const isNew = !p.id;
      const s = clone(p);
      s.settings = { transition: 'fade', transitionMs: 800, handoverAtMs: 1000, posterHoldMs: 6000, ...(s.settings || {}) };
      s.overlay.secondaryCta ??= null;
      const err = h('p', { class: 'hq-error', role: 'alert', hidden: true });

      // datalists of uploads for the URL fields
      const lists = ['video', 'webm', 'image'].map((k) => h('datalist', { id: `hq-media-${k}` },
        media.filter((m) => (k === 'image' ? m.kind === 'image' : k === 'webm' ? m.type === 'video/webm' : m.kind === 'video'))
          .map((m) => h('option', { value: m.url }, m.label || m.name))));

      const desk = h('section', { class: 'hero hero-preview', 'aria-label': 'Desktop preview' });
      const phone = h('section', { class: 'hero hero-preview is-phone', 'aria-label': 'Phone preview' });
      const previewOpts = { observe: false, headingTag: 'h2' };
      let heroes = [];
      const promoForPreview = () => ({ overlay: s.overlay, slides: s.slides.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== '' && v != null))), settings: s.settings });
      function startPreview() {
        for (const x of heroes) x.destroy();
        // The phone frame uses the phone media whatever this screen is.
        heroes = [createHero(desk, promoForPreview(), { ...previewOpts, env: { portrait: false } }), createHero(phone, promoForPreview(), { ...previewOpts, env: { portrait: true } })];
      }
      let t = 0;
      const refresh = () => { clearTimeout(t); t = setTimeout(() => { for (const x of heroes) x.update(promoForPreview()); }, 200); };
      cleanups.push(() => { clearTimeout(t); for (const x of heroes) x.destroy(); });

      const text = (obj, key, label, max, { span, ...attrs } = {}) => {
        const input = h(max > 120 ? 'textarea' : 'input', { name: key, maxlength: max, ...(max > 120 ? { rows: 2 } : {}), value: obj[key] ?? '', ...attrs });
        input.addEventListener('input', () => { obj[key] = input.value; refresh(); });
        return h('label', { class: ['field', span ? 'span-2' : null] }, h('span', null, label), input);
      };
      const ctaFields = (obj, key, title, name) => {
        const c = obj[key] || { label: '', href: '' };
        const set = () => { obj[key] = c.label || c.href ? c : null; refresh(); };
        const label = h('input', { name: `${name}.label`, maxlength: 40, value: c.label || '' });
        const href = h('input', { name: `${name}.href`, maxlength: 500, value: c.href || '', placeholder: '/site/signup.html?plan=pro' });
        label.addEventListener('input', () => { c.label = label.value; set(); });
        href.addEventListener('input', () => { c.href = href.value; set(); });
        return [h('label', { class: 'field' }, h('span', null, `${title}: label`), label), h('label', { class: 'field' }, h('span', null, `${title}: link`), href)];
      };

      const slidesBox = h('div', { class: 'stack' });
      function drawSlides() {
        ui.clear(slidesBox);
        s.slides.forEach((sl, i) => {
          sl.overlay ||= {};
          const urlField = ([key, label, kind]) => {
            const input = h('input', { name: `slides.${i}.${key}`, value: sl[key] || '', list: `hq-media-${kind}`, placeholder: kind === 'image' ? '/media/….jpg' : '/media/….mp4', maxlength: 500 });
            input.addEventListener('input', () => { sl[key] = input.value.trim(); refresh(); });
            return h('label', { class: 'field' }, h('span', null, label), input);
          };
          const hint = sl.videoDesktop && !sl.poster ? h('p', { class: 'muted hq-small' }, 'Tip: add a poster (the first frame) so nothing blank shows while the clip loads.') : null;
          slidesBox.append(h('div', { class: 'card flat hq-slide' },
            h('div', { class: 'row' }, h('h3', { class: 'grow' }, `Slide ${i + 1}`),
              ui.button('', { size: 'sm', icon: 'chevron-left', title: `Move slide ${i + 1} earlier`, disabled: i === 0, onClick: () => { [s.slides[i - 1], s.slides[i]] = [s.slides[i], s.slides[i - 1]]; drawSlides(); startPreview(); } }),
              ui.button('', { size: 'sm', icon: 'chevron-right', title: `Move slide ${i + 1} later`, disabled: i === s.slides.length - 1, onClick: () => { [s.slides[i + 1], s.slides[i]] = [s.slides[i], s.slides[i + 1]]; drawSlides(); startPreview(); } }),
              ui.button('', { size: 'sm', icon: 'trash', variant: 'ghost danger', title: `Remove slide ${i + 1}`, disabled: s.slides.length <= 3, onClick: () => { s.slides.splice(i, 1); drawSlides(); startPreview(); } })),
            h('div', { class: 'form-grid' }, SLIDE_MEDIA.map(urlField)), hint,
            h('details', null, h('summary', null, 'Different text on this slide (blank = the promotion text)'),
              h('div', { class: 'form-grid' }, TEXT.slice(0, 3).map(([k, l, m]) => text(sl.overlay, k, l, m, { name: `slides.${i}.overlay.${k}` }))))));
        });
        slidesBox.append(h('div', { class: 'row' },
          ui.button('Add slide', { icon: 'plus', size: 'sm', disabled: s.slides.length >= 5, onClick: () => { s.slides.push({ poster: '' }); drawSlides(); } }),
          h('span', { class: 'muted hq-small' }, '3 to 5 slides. Each needs a poster or a video.')));
      }
      drawSlides();

      const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);
      const sel = (name, value, options, onChange) => {
        const e = h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
        e.addEventListener('change', () => onChange(e.value));
        return e;
      };
      const num = (name, value, min, max, onChange) => {
        const e = h('input', { type: 'number', name, value, min, max, step: name.endsWith('Ms') ? 100 : 1 });
        e.addEventListener('input', () => { onChange(e.value === '' ? null : Number(e.value)); });
        return e;
      };
      const dt = (name, value, onChange) => {
        const e = h('input', { type: 'datetime-local', name, value: localInput(value) });
        e.addEventListener('change', () => onChange(fromLocal(e.value)));
        return e;
      };

      const saveBtn = ui.button(isNew ? 'Create promotion' : 'Save', { variant: 'primary', icon: 'save', onClick: save });
      const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); save(); } },
        h('div', { class: 'card' }, h('h3', null, 'Promotion'),
          h('div', { class: 'form-grid' },
            text(s, 'name', 'Name (HQ only)', 120),
            field('Status', sel('status', s.status || 'draft', [['draft', 'Draft (not shown)'], ['active', 'Active (runs in its window)'], ['inactive', 'Inactive']], (v) => { s.status = v; })),
            field('Starts (blank = now)', dt('startsAt', s.startsAt, (v) => { s.startsAt = v; })),
            field('Ends (blank = no end)', dt('endsAt', s.endsAt, (v) => { s.endsAt = v; })),
            field('Priority (highest wins)', num('priority', s.priority ?? 0, -1000, 1000, (v) => { s.priority = v ?? 0; })),
            text(s, 'audience', 'Audience tag (blank = everyone, e.g. province=ON)', 97, { placeholder: 'province=ON' }),
            text(s, 'notes', 'Notes (HQ only)', 2000, { span: true }))),
        h('div', { class: 'card' }, h('h3', null, 'Text over the video'),
          h('div', { class: 'form-grid' },
            ...TEXT.map(([k, l, m]) => text(s.overlay, k, l, m, { name: `overlay.${k}`, ...(k === 'subline' ? { span: true } : {}) })),
            ...ctaFields(s.overlay, 'primaryCta', 'Main button', 'overlay.primaryCta'),
            ...ctaFields(s.overlay, 'secondaryCta', 'Second button (optional)', 'overlay.secondaryCta'))),
        h('div', { class: 'card' }, h('h3', null, 'Slides'), lists, slidesBox),
        h('div', { class: 'card' }, h('h3', null, 'Timing'),
          h('div', { class: 'form-grid' },
            field('Transition', sel('settings.transition', s.settings.transition, [['fade', 'Crossfade'], ['slide', 'Slide']], (v) => { s.settings.transition = v; startPreview(); })),
            field('Transition length (ms)', num('settings.transitionMs', s.settings.transitionMs, 200, 3000, (v) => { s.settings.transitionMs = v; })),
            field('Start the next clip this long before the end (ms)', num('settings.handoverAtMs', s.settings.handoverAtMs, 300, 4000, (v) => { s.settings.handoverAtMs = v; })),
            field('Poster-only slide length (ms)', num('settings.posterHoldMs', s.settings.posterHoldMs, 2000, 20000, (v) => { s.settings.posterHoldMs = v; })))),
        err,
        h('div', { class: 'row' }, saveBtn, h('span', { class: 'grow' }),
          isNew ? null : ui.button('Duplicate', { icon: 'copy', onClick: () => duplicate(p) }),
          isNew ? null : p.status === 'active' ? ui.button('Deactivate', { onClick: async () => { await setStatusInEditor('inactive'); } }) : ui.button('Activate', { onClick: async () => { await setStatusInEditor('active'); } }),
          isNew ? null : ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: remove })));

      async function setStatusInEditor(status) {
        try { await post(`/api/hq/promotions/${p.id}/status`, { status }); ui.toast(status === 'active' ? 'Activated' : 'Deactivated', 'success'); nav(`promotions/${p.id}`); } catch (e) { ui.toast(errorText(e), 'error', 5000); }
      }
      async function remove() {
        if (!(await ui.confirmDialog(`Delete "${p.name}"? This can't be undone.`, { okLabel: 'Delete' }))) return;
        try { await del(`/api/hq/promotions/${p.id}`); ui.toast('Deleted', 'success'); nav('promotions'); } catch (e) { ui.toast(errorText(e), 'error', 5000); }
      }
      async function save() {
        err.hidden = true;
        const payload = {
          name: s.name, status: s.status || 'draft', startsAt: s.startsAt || null, endsAt: s.endsAt || null, priority: s.priority ?? 0,
          audience: s.audience?.trim() || null, notes: s.notes || '', settings: s.settings,
          overlay: Object.fromEntries(Object.entries(s.overlay).filter(([k, v]) => v !== '' && (v !== null || k === 'secondaryCta'))),
          slides: s.slides.map((x) => {
            const out = Object.fromEntries(Object.entries(x).filter(([k, v]) => k !== 'overlay' && v));
            const o = Object.fromEntries(Object.entries(x.overlay || {}).filter(([, v]) => v));
            if (Object.keys(o).length) out.overlay = o;
            return out;
          }),
          ...(isNew ? {} : { version: p.version }),
        };
        saveBtn.disabled = true;
        try {
          const r = isNew ? await post('/api/hq/promotions', payload) : await put(`/api/hq/promotions/${p.id}`, payload);
          ui.toast(isNew ? 'Promotion created' : 'Saved. The landing page picks it up within 30 seconds.', 'success', 4000);
          nav(`promotions/${r.id}`);
        } catch (e) {
          err.textContent = errorText(e);
          err.hidden = false;
          err.scrollIntoView({ block: 'nearest' });
        } finally { saveBtn.disabled = false; }
      }

      const state = isNew ? null : h('div', { class: 'hq-pill-list' }, ui.badge(p.state, STATE_TONE[p.state]), p.serving ? ui.badge('serving', 'accent') : null,
        h('span', { class: 'muted hq-small' }, `v${p.version} · changed ${ago(p.updatedAt)}${p.updatedByName ? ` by ${p.updatedByName}` : ''}`));
      body.append(h('div', { class: 'hq-promo-editor' },
        h('div', { class: 'stack' }, state, form),
        h('aside', { class: 'stack hq-promo-preview', 'aria-label': 'Live preview' },
          h('h3', null, 'Live preview'), desk,
          h('div', { class: 'hq-promo-phone' }, phone, h('p', { class: 'muted hq-small' }, 'Phone (portrait). Videos play muted, as on the site. Text and buttons update as you type; save to publish.')))));
      body.append(...ui.section('Media library', mediaLibrary()));
      startPreview();
    }

    (async () => {
      try { await loadAll(); } catch (e) { ui.clear(body); body.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); return; }
      if (!id) { drawList(); return; }
      if (id === 'new') {
        const d = clone(list.defaultPromotion);
        drawEditor({ name: '', status: 'draft', priority: 0, audience: null, notes: '', overlay: d.overlay, slides: d.slides, settings: d.settings });
        return;
      }
      let p = list.data.find((x) => x.id === id);
      if (!p) { try { p = await get(`/api/hq/promotions/${id}`); } catch { ui.toast('No such promotion', 'error'); nav('promotions'); return; } }
      drawEditor(p);
    })();

    return () => { for (const fn of cleanups.splice(0)) fn(); };
  },
};
