// SOPs: a library of step-by-step procedures, versioned, acknowledged by staff.
import { ROLES } from '../auth.js';

const ackedCurrent = (sop) => (sop.acks || []).filter((a) => a.version === sop.version);

function audience(store, sop) {
  const roles = sop.requiredRoles || [];
  return store.list('employees', (e) => e.active !== false && (!roles.length || roles.includes(e.role)));
}

function ackProgress(store, sop) {
  const people = audience(store, sop);
  const ids = new Set(ackedCurrent(sop).map((a) => a.employeeId));
  const done = people.filter((p) => ids.has(p.id)).length;
  return { done, total: people.length, people, ids };
}

export default {
  id: 'sops',
  title: 'SOPs',
  icon: 'book',
  group: 'field',
  perm: 'sops',
  render(root, ctx) {
    const { params } = ctx;
    if (params[0] === 'new') return editor(root, ctx, null);
    if (params[0] && params[1] === 'edit') return editor(root, ctx, ctx.store.get('sops', params[0]));
    if (params[0]) return reader(root, ctx, params[0]);
    return library(root, ctx);
  },
};

function library(root, { store, ui, auth, nav }) {
  const { h } = ui;
  let q = '';
  const body = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(body);
    const me = auth.current();
    const sops = store.list('sops').filter((s) => !q || `${s.title} ${s.category} ${(s.steps || []).map((x) => x.text).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
    if (!sops.length) {
      body.append(ui.empty({ icon: 'book', title: q ? 'No SOPs match' : 'No SOPs yet', text: 'Write down how your crew does things, step by step.',
        action: auth.isManager() ? ui.button('New SOP', { variant: 'primary', icon: 'plus', onClick: () => nav('sops/new') }) : null }));
      return;
    }
    const groups = {};
    for (const s of sops) (groups[s.category || 'General'] ||= []).push(s);
    for (const cat of Object.keys(groups).sort()) {
      body.append(h('h2', { class: 'section' }, cat));
      body.append(h('div', { class: 'grid' }, groups[cat].sort((a, b) => a.title.localeCompare(b.title)).map((s) => {
        const p = ackProgress(store, s);
        const mine = (s.requiredRoles || []).includes(me.role) || !(s.requiredRoles || []).length;
        const iAcked = p.ids.has(me.id);
        return h('a', { class: 'card click sop-card', href: `#/sops/${s.id}` },
          h('div', { class: 'row' }, ui.badge(`v${s.version || 1}`, 'neutral'), h('span', { class: 'muted' }, `${(s.steps || []).length} steps`),
            h('span', { class: 'grow' }), mine ? (iAcked ? ui.badge('Read', 'success') : ui.badge('To read', 'warning')) : null),
          h('h3', null, s.title),
          h('div', { class: 'meta muted' }, `${p.done} of ${p.total} acknowledged`),
          h('div', { class: 'progress' }, h('i', { style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })));
      })));
    }
  };
  root.append(ui.page({
    title: 'SOPs', subtitle: 'How we do things, step by step',
    actions: [ui.searchBox('Search SOPs', (v) => { q = v; draw(); }), auth.isManager() ? ui.button('New SOP', { variant: 'primary', icon: 'plus', onClick: () => nav('sops/new') }) : null].filter(Boolean),
  }, body));
  draw();
  return store.on('sops', draw);
}

function reader(root, ctx, id) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const sop = store.get('sops', id);
  if (!sop) { root.append(ui.page({ title: 'SOP' }, ui.empty({ icon: 'book', title: 'SOP not found', action: ui.button('Back to SOPs', { href: '#/sops' }) }))); return; }
  const me = auth.current();
  const p = ackProgress(store, sop);
  const iAcked = p.ids.has(me.id);
  const checked = new Set();
  const steps = h('ol', { class: 'sop-steps' }, (sop.steps || []).map((s, i) => {
    const li = h('li', null, h('button', {
      type: 'button', class: 'sop-step', 'aria-pressed': 'false',
      onClick: (e) => {
        const b = e.currentTarget;
        if (checked.has(i)) checked.delete(i); else checked.add(i);
        b.setAttribute('aria-pressed', String(checked.has(i)));
        ackBtn.disabled = iAcked || !me.id || checked.size < (sop.steps || []).length;
      },
    }, h('span', { class: 'sop-num' }, String(i + 1)), h('span', { class: 'sop-text' }, s.text), h('span', { class: 'sop-tick' }, ui.icon('check', 22))));
    return li;
  }));
  const ackBtn = ui.button(iAcked ? `You acknowledged v${sop.version}` : `I've read and understood v${sop.version}`, {
    variant: iAcked ? 'secondary' : 'primary', size: 'lg', icon: iAcked ? 'check' : null, disabled: true,
    onClick: () => {
      const cur = store.get('sops', id);
      if ((cur.acks || []).some((a) => a.employeeId === me.id && a.version === cur.version)) return;
      store.update('sops', id, { acks: [...(cur.acks || []), { employeeId: me.id, version: cur.version, at: new Date().toISOString() }] }, { summary: `${me.name} acknowledged ${cur.title} v${cur.version}` });
      ui.toast('Acknowledged', 'success');
      ctx.route();
    },
  });
  if (!iAcked && !(sop.steps || []).length) ackBtn.disabled = !me.id;

  const ackAt = Object.fromEntries(ackedCurrent(sop).map((a) => [a.employeeId, a.at]));
  const who = h('div', { class: 'list' }, p.people.length ? p.people.map((e) => h('div', { class: 'list-row' },
    h('span', { class: 'avatar', style: { background: e.color || '#5f5a51' } }, ui.initials(e.name)),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, e.name), h('div', { class: 'meta' }, ROLES[e.role]?.label || e.role)),
    p.ids.has(e.id) ? h('span', { class: 'row' }, ui.badge('Acknowledged', 'success'), h('span', { class: 'meta muted' }, ui.fmtDate(ackAt[e.id]))) : ui.badge('Not yet', 'warning'))) : h('div', { class: 'list-row muted' }, 'No one is assigned this SOP.'));

  root.append(ui.page({
    title: sop.title,
    subtitle: `${sop.category || 'General'} · version ${sop.version || 1} · ${(sop.requiredRoles || []).map((r) => ROLES[r]?.label || r).join(', ') || 'Everyone'}`,
    actions: [
      ui.button('All SOPs', { variant: 'ghost', icon: 'chevron-left', href: '#/sops' }),
      ui.button('Print', { icon: 'printer', onClick: () => print() }),
      auth.isManager() ? ui.button('Edit', { icon: 'edit', onClick: () => nav(`sops/${id}/edit`) }) : null,
    ].filter(Boolean),
  },
  h('p', { class: 'muted no-print' }, iAcked ? 'You have acknowledged this version.' : 'Tap each step as you read it, then acknowledge at the bottom.'),
  steps,
  h('div', { class: 'row no-print', style: { margin: '24px 0' } }, ackBtn),
  h('div', { class: 'no-print' }, ...ui.section(`Acknowledgements for v${sop.version} (${p.done}/${p.total})`, who))));
}

function editor(root, ctx, sop) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  if (!auth.isManager()) { root.append(ui.page({ title: 'Edit SOP' }, ui.empty({ icon: 'lock', title: 'Managers only' }))); return; }
  if (ctx.params[0] !== 'new' && !sop) { root.append(ui.page({ title: 'Edit SOP' }, ui.empty({ icon: 'book', title: 'SOP not found' }))); return; }
  const draft = sop ? structuredClone(sop) : { title: '', category: 'Safety', version: 1, requiredRoles: ['foreman', 'electrician', 'apprentice'], steps: [{ text: '' }], acks: [] };
  const original = JSON.stringify({ t: draft.title, s: draft.steps.map((s) => s.text) });

  const title = ui.field({ label: 'Title', name: 'title', value: draft.title, required: true, span: true });
  const cats = [...new Set(['Safety', 'Install', 'Customer', 'Admin', ...store.list('sops').map((s) => s.category).filter(Boolean)])];
  const category = ui.field({ label: 'Category', name: 'category', value: draft.category, hint: 'e.g. ' + cats.slice(0, 4).join(', ') });
  const roleBoxes = h('div', { class: 'row' }, Object.entries(ROLES).map(([k, r]) => ui.field({ type: 'checkbox', label: r.label, name: 'role-' + k, value: (draft.requiredRoles || []).includes(k) })));
  const stepsHost = h('ol', { class: 'sop-edit-steps' });
  const drawSteps = () => {
    ui.clear(stepsHost);
    draft.steps.forEach((s, i) => {
      const ta = h('textarea', { class: 'input', rows: 2, 'aria-label': `Step ${i + 1}`, onInput: (e) => { s.text = e.target.value; } }, s.text);
      stepsHost.append(h('li', { class: 'sop-edit-step' },
        h('span', { class: 'sop-num' }, String(i + 1)), ta,
        h('div', { class: 'row' },
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'chevron-down', title: 'Move down', disabled: i === draft.steps.length - 1, onClick: () => { [draft.steps[i], draft.steps[i + 1]] = [draft.steps[i + 1], draft.steps[i]]; drawSteps(); } }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: '<path d="M5 15l7-7 7 7"/>', title: 'Move up', disabled: i === 0, onClick: () => { [draft.steps[i], draft.steps[i - 1]] = [draft.steps[i - 1], draft.steps[i]]; drawSteps(); } }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Remove step', onClick: () => { draft.steps.splice(i, 1); drawSteps(); } }))));
    });
  };
  drawSteps();

  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'card stack' }, ui.formGrid([title, category]), h('div', { class: 'field' }, h('span', null, 'Who must acknowledge it'), roleBoxes)),
    ...ui.section('Steps', h('div', { class: 'card stack' }, stepsHost, h('div', null, ui.button('Add step', { icon: 'plus', onClick: () => { draft.steps.push({ text: '' }); drawSteps(); stepsHost.lastChild?.querySelector('textarea')?.focus(); } })))),
    h('p', { class: 'muted' }, sop ? `Changing the title or steps publishes v${(sop.version || 1) + 1} and everyone must acknowledge it again.` : ''));

  function save() {
    if (!form.reportValidity()) return;
    const v = ui.readForm(form);
    const steps = draft.steps.map((s) => ({ text: s.text.trim() })).filter((s) => s.text);
    if (!steps.length) return ui.toast('Add at least one step', 'error');
    const fields = {
      title: v.title.trim(), category: (v.category || 'General').trim(), steps,
      requiredRoles: Object.keys(ROLES).filter((k) => v['role-' + k]),
    };
    if (!sop) {
      const rec = store.add('sops', { ...fields, version: 1, acks: [] });
      ui.toast('SOP created', 'success');
      return nav(`sops/${rec.id}`);
    }
    const changed = JSON.stringify({ t: fields.title, s: steps.map((s) => s.text) }) !== original;
    store.update('sops', sop.id, { ...fields, version: changed ? (sop.version || 1) + 1 : sop.version || 1 },
      { summary: `${fields.title}${changed ? ` → v${(sop.version || 1) + 1}` : ''}` });
    ui.toast(changed ? `Published v${(sop.version || 1) + 1}` : 'Saved', 'success');
    nav(`sops/${sop.id}`);
  }

  root.append(ui.page({
    title: sop ? `Edit: ${sop.title}` : 'New SOP',
    actions: [
      sop ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: async () => { if (await ui.confirmDialog(`Delete "${sop.title}"?`, { okLabel: 'Delete' })) { store.remove('sops', sop.id); nav('sops'); } } }) : null,
      ui.button('Cancel', { variant: 'ghost', onClick: () => nav(sop ? `sops/${sop.id}` : 'sops') }),
      ui.button(sop ? 'Save' : 'Create SOP', { variant: 'primary', icon: 'save', onClick: save }),
    ].filter(Boolean),
  }, form));
}
