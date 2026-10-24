// SOPs: a library of step-by-step procedures, versioned, acknowledged by staff. A SOP with the
// job-standard fields filled in is a region-specific "job standard" (docs/releases/job-standards.md):
// a work-type playbook that bundles a material list, breakers & panel, wire/connection specs and a
// task list, and that the office can apply to a job. Existing safety SOPs are untouched.
import { ROLES } from '../auth.js';
import { PROVINCES, provinceName } from '../lib/tax.js';
import { BREAKER_TYPES, breakerTypeLabel, listBreakerTemplates, listPanelTemplates } from '../lib/panel-templates.js';
import { isStandard, filterStandards, visibleRequirements, standardProvinces, standardAuthority } from '../lib/job-standards.js';

// The document revision. The server owns a record's `version` (its row counter), so SOPs use
// `revision`; acknowledgements made before that change still carry `version`.
export const sopRev = (s) => s?.revision ?? 1;
export const ackRev = (a) => a?.revision ?? a?.version ?? null;

const SCALES = ['small', 'service', 'residential', 'light-commercial', 'commercial', 'condo'];
const AUTHORITIES = ['Manitoba Hydro', 'City of Winnipeg'];

const ackedCurrent = (sop) => (sop.acks || []).filter((a) => ackRev(a) === sopRev(sop));

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

/** The company's province, the default region lens for standards. */
const companyProvince = (store) => store.settings().company?.province || 'ON';

/** A short region label for a standard's card ("MB · Manitoba Hydro", "Anywhere"). */
function regionLabel(sop) {
  const ps = standardProvinces(sop);
  const auth = standardAuthority(sop);
  const where = ps.length ? ps.join(', ') : 'Anywhere';
  return auth ? `${where} · ${auth}` : where;
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

function library(root, ctx) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  let q = '';
  let view = ctx.query.view === 'standards' ? 'standards' : 'procedures';
  let region = companyProvince(store);
  const body = h('div', { class: 'stack' });

  const procedureCards = (me) => {
    const sops = store.list('sops').filter((s) => !isStandard(s))
      .filter((s) => !q || `${s.title} ${s.category} ${(s.steps || []).map((x) => x.text).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
    if (!sops.length) {
      body.append(ui.empty({ icon: 'book', title: q ? 'No SOPs match' : 'No SOPs yet', text: 'Write down how your crew does things, step by step.',
        action: auth.isManager() ? ui.button('New SOP', { variant: 'primary', icon: 'plus', onClick: () => nav('sops/new') }) : null }));
      return;
    }
    const groups = {};
    for (const s of sops) (groups[s.category || 'General'] ||= []).push(s);
    for (const cat of Object.keys(groups).sort()) {
      body.append(h('h2', { class: 'section' }, cat));
      body.append(h('div', { class: 'grid' }, groups[cat].sort((a, b) => a.title.localeCompare(b.title)).map((s) => sopCard(s, me))));
    }
  };

  const sopCard = (s, me) => {
    const p = ackProgress(store, s);
    const mine = (s.requiredRoles || []).includes(me.role) || !(s.requiredRoles || []).length;
    const iAcked = p.ids.has(me.id);
    return h('a', { class: 'card click sop-card', href: `#/sops/${s.id}` },
      h('div', { class: 'row' }, ui.badge(`v${sopRev(s)}`, 'neutral'), h('span', { class: 'muted' }, `${(s.steps || []).length} steps`),
        h('span', { class: 'grow' }), mine ? (iAcked ? ui.badge('Read', 'success') : ui.badge('To read', 'warning')) : null),
      h('h3', null, s.title),
      h('div', { class: 'meta muted' }, `${p.done} of ${p.total} acknowledged`),
      h('div', { class: 'progress' }, h('i', { style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })));
  };

  const standardCard = (s, me) => {
    const p = ackProgress(store, s);
    const iAcked = p.ids.has(me.id);
    const counts = [`${(s.materials || []).length} materials`, `${(s.breakers || []).length} breakers`, `${(s.tasks || []).length} tasks`];
    return h('a', { class: 'card click sop-card', href: `#/sops/${s.id}` },
      h('div', { class: 'row' }, ui.badge(`v${sopRev(s)}`, 'neutral'), s.scale ? ui.badge(s.scale, 'accent') : null,
        h('span', { class: 'grow' }), iAcked ? ui.badge('Read', 'success') : ui.badge('To read', 'warning')),
      h('h3', null, s.jobType || s.title),
      h('div', { class: 'meta muted' }, ui.icon('map-pin', 14), ' ', regionLabel(s)),
      h('div', { class: 'meta muted' }, counts.join(' · ')));
  };

  const standardCards = (me) => {
    const rows = filterStandards(store.list('sops'), { province: region === 'all' ? null : region, q });
    if (!rows.length) {
      body.append(ui.empty({ icon: 'book', title: q ? 'No job standards match' : 'No job standards yet',
        text: 'A job standard is a work-type playbook: material list, breakers, specs and tasks for an RTM hookup, hot tub, panel change, and so on. Look up your job, have your material list, good to go.',
        action: auth.isManager() ? ui.button('New job standard', { variant: 'primary', icon: 'plus', onClick: () => nav('sops/new?standard=1') }) : null }));
      return;
    }
    const provincesInUse = [...new Set(store.list('sops').filter(isStandard).flatMap(standardProvinces))].sort();
    const options = [{ value: companyProvince(store), label: `${provinceName(companyProvince(store))} (your province)` },
      { value: 'all', label: 'All regions' }, ...provincesInUse.filter((p) => p !== companyProvince(store)).map((p) => ({ value: p, label: provinceName(p) }))];
    const regionSel = h('select', { class: 'input', 'aria-label': 'Region', onChange: (e) => { region = e.target.value; draw(); } },
      options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(region) }, o.label)));
    body.append(h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } }, h('span', { class: 'muted' }, 'Region'), regionSel));
    body.append(h('div', { class: 'grid' }, rows.map((s) => standardCard(s, me))));
  };

  const draw = () => {
    ui.clear(body);
    const me = auth.current();
    body.append(ui.tabs([{ id: 'procedures', label: 'Procedures' }, { id: 'standards', label: 'Job standards' }], view, (id) => { view = id; draw(); }));
    if (view === 'standards') standardCards(me);
    else procedureCards(me);
  };

  root.append(ui.page({
    title: 'SOPs', subtitle: 'How we do things, step by step',
    actions: [ui.searchBox('Search SOPs and standards', (v) => { q = v; draw(); }),
      auth.isManager() ? ui.button('New SOP', { variant: 'primary', icon: 'plus', onClick: () => nav(view === 'standards' ? 'sops/new?standard=1' : 'sops/new') }) : null].filter(Boolean),
  }, body));
  draw();
  return store.on('sops', draw);
}

/** The crew-safe standard sections (region requirements, specs, breakers & panel, materials, tasks). */
function standardSections(ctx, sop) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const showMoney = auth.seesMoney();
  const out = [];
  const reqs = visibleRequirements(sop, { province: companyProvince(store) });
  if (reqs.length) {
    out.push(h('div', { class: 'card', style: { borderLeft: '4px solid var(--warning, #b8860b)' } },
      h('h3', null, ui.icon('info', 16), ' Region requirements'),
      h('ul', { class: 'sop-reqs' }, reqs.map((r) => h('li', null,
        r.province || r.authority ? h('strong', null, [r.province, r.authority].filter(Boolean).join(' · ') + ': ') : null, r.text)))));
  }
  if ((sop.specs || []).length) {
    out.push(...ui.section('Specs', h('div', { class: 'list' }, sop.specs.filter((s) => s.label || s.value).map((s) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, s.label || ''), h('div', { class: 'meta muted' }, s.value || ''))))));
  }
  if ((sop.breakers || []).length || sop.panelTemplateId) {
    const preset = sop.panelTemplateId ? listPanelTemplates(store.settings()).find((p) => p.id === sop.panelTemplateId) : null;
    out.push(...ui.section('Breakers & panel',
      preset ? h('p', { class: 'muted' }, `Panel: ${preset.label}`) : null,
      h('div', { class: 'list' }, (sop.breakers || []).map((b) => h('div', { class: 'list-row' },
        ui.badge(breakerTypeLabel(b.breakerType), 'neutral'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${b.qty || 1} × ${b.poles || 1}P ${b.amps ? b.amps + 'A' : ''}`.trim()),
          b.note ? h('div', { class: 'meta muted' }, b.note) : null))))));
  }
  if ((sop.materials || []).length) {
    const items = new Map(store.list('items').map((i) => [i.id, i]));
    out.push(...ui.section('Materials',
      h('div', { class: 'list' }, sop.materials.map((m) => {
        const item = m.itemId ? items.get(m.itemId) : null;
        const cost = showMoney && item && Number.isFinite(Number(item.costCents)) ? ui.fmtMoney(Math.round(item.costCents * (Number(m.qty) || 0))) : null;
        return h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `${m.qty ?? ''} ${m.unit || ''} ${m.name || item?.name || 'Material'}`.trim()),
            m.note ? h('div', { class: 'meta muted' }, m.note) : null),
          cost ? h('span', { class: 'num muted' }, cost) : null);
      }))));
  }
  if ((sop.tasks || []).length) {
    out.push(...ui.section('Task list', h('div', { class: 'list' }, sop.tasks.filter((t) => t.title).map((t) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title),
        h('div', { class: 'meta muted' }, [t.phaseName, t.estHours ? `${t.estHours} h` : null, t.requiresPhoto ? 'photo' : null].filter(Boolean).join(' · '))))))));
  }
  return out;
}

function reader(root, ctx, id) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const sop = store.get('sops', id);
  if (!sop) { root.append(ui.page({ title: 'SOP' }, ui.empty({ icon: 'book', title: 'SOP not found', action: ui.button('Back to SOPs', { href: '#/sops' }) }))); return; }
  const standard = isStandard(sop);
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
  const ackBtn = ui.button(iAcked ? `You acknowledged v${sopRev(sop)}` : `I've read and understood v${sopRev(sop)}`, {
    variant: iAcked ? 'secondary' : 'primary', size: 'lg', icon: iAcked ? 'check' : null, disabled: true,
    onClick: () => {
      const cur = store.get('sops', id);
      if ((cur.acks || []).some((a) => a.employeeId === me.id && ackRev(a) === sopRev(cur))) return;
      store.update('sops', id, { acks: [...(cur.acks || []), { employeeId: me.id, revision: sopRev(cur), at: new Date().toISOString() }] }, { summary: `${me.name} acknowledged ${cur.title} v${sopRev(cur)}` });
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
    title: sop.jobType || sop.title,
    subtitle: standard
      ? `Job standard · ${regionLabel(sop)} · version ${sopRev(sop)}`
      : `${sop.category || 'General'} · version ${sopRev(sop)} · ${(sop.requiredRoles || []).map((r) => ROLES[r]?.label || r).join(', ') || 'Everyone'}`,
    actions: [
      ui.button('All SOPs', { variant: 'ghost', icon: 'chevron-left', href: '#/sops' }),
      ui.button('Print', { icon: 'printer', onClick: () => print() }),
      auth.isManager() ? ui.button('Edit', { icon: 'edit', onClick: () => nav(`sops/${id}/edit`) }) : null,
    ].filter(Boolean),
  },
  standard ? h('div', { class: 'stack' }, ...standardSections(ctx, sop)) : null,
  (sop.steps || []).length ? h('h2', { class: 'section' }, 'Steps') : null,
  h('p', { class: 'muted no-print' }, iAcked ? 'You have acknowledged this version.' : 'Tap each step as you read it, then acknowledge at the bottom.'),
  steps,
  h('div', { class: 'row no-print', style: { margin: '24px 0' } }, ackBtn),
  h('div', { class: 'no-print' }, ...ui.section(`Acknowledgements for v${sopRev(sop)} (${p.done}/${p.total})`, who))));
}

function editor(root, ctx, sop) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  if (!auth.isManager()) { root.append(ui.page({ title: 'Edit SOP' }, ui.empty({ icon: 'lock', title: 'Managers only' }))); return; }
  if (ctx.params[0] !== 'new' && !sop) { root.append(ui.page({ title: 'Edit SOP' }, ui.empty({ icon: 'book', title: 'SOP not found' }))); return; }
  const startStandard = sop ? isStandard(sop) : ctx.query.standard === '1';
  const draft = sop ? structuredClone(sop) : {
    title: '', category: startStandard ? 'Job standards' : 'Safety', revision: 1,
    requiredRoles: ['foreman', 'electrician', 'apprentice'], steps: [{ text: '' }], acks: [],
  };
  draft.steps ||= [{ text: '' }];
  // Standard sub-collections, defaulted so the row editors have something to push onto.
  draft.region ||= { provinces: [], authority: '' };
  draft.regionRequirements ||= [];
  draft.materials ||= [];
  draft.breakers ||= [];
  draft.specs ||= [];
  draft.tasks ||= [];
  const provinces = new Set((draft.region.provinces || []).map((p) => String(p).toUpperCase()));
  const original = JSON.stringify({ t: draft.title, s: draft.steps.map((s) => s.text) });
  const showMoney = auth.seesMoney();
  let isStd = startStandard;

  const title = ui.field({ label: 'Title', name: 'title', value: draft.title, required: true, span: true });
  const cats = [...new Set(['Safety', 'Install', 'Customer', 'Admin', 'Job standards', ...store.list('sops').map((s) => s.category).filter(Boolean)])];
  const category = ui.field({ label: 'Category', name: 'category', value: draft.category, hint: 'e.g. ' + cats.slice(0, 4).join(', ') });
  const roleBoxes = h('div', { class: 'row' }, Object.entries(ROLES).map(([k, r]) => ui.field({ type: 'checkbox', label: r.label, name: 'role-' + k, value: (draft.requiredRoles || []).includes(k) })));

  // ---- steps (unchanged) ----
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

  // ---- the standard fields, revealed behind a checkbox ----
  const stdField = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  const smallInput = (value, attrs, onInput) => h('input', { class: 'input', value: value ?? '', ...attrs, onInput: (e) => onInput(e.target.value) });

  const jobTypeInput = smallInput(draft.jobType, { 'aria-label': 'Job type', placeholder: 'e.g. RTM hookup, Hot tub, 200A panel change' }, (v) => { draft.jobType = v; });
  const scaleSel = h('select', { class: 'input', 'aria-label': 'Scale' },
    [{ value: '', label: '— scale —' }, ...SCALES.map((s) => ({ value: s, label: s }))].map((o) => h('option', { value: o.value, selected: o.value === (draft.scale || '') }, o.label)));
  if (draft.scale && !SCALES.includes(draft.scale)) scaleSel.append(h('option', { value: draft.scale, selected: true }, draft.scale));
  scaleSel.addEventListener('change', (e) => { draft.scale = e.target.value; });
  const authorityInput = smallInput(draft.region.authority, { 'aria-label': 'Authority', placeholder: 'e.g. Manitoba Hydro, City of Winnipeg', list: 'sop-authorities' }, (v) => { draft.region.authority = v; });
  const authorityList = h('datalist', { id: 'sop-authorities' }, AUTHORITIES.map((a) => h('option', { value: a })));

  const provinceChips = h('div', { class: 'ops-crew-pick' }, PROVINCES.map((p) => h('label', { class: 'ops-chip-check' },
    h('input', { type: 'checkbox', checked: provinces.has(p.code), onChange: (e) => (e.target.checked ? provinces.add(p.code) : provinces.delete(p.code)) }), p.code)));

  const reqHost = h('div', { class: 'stack' });
  const drawReqs = () => {
    ui.clear(reqHost);
    draft.regionRequirements.forEach((r, i) => {
      reqHost.append(h('div', { class: 'card flat stack' },
        h('div', { class: 'form-grid' },
          stdField('Province', smallInput(r.province, { 'aria-label': 'Requirement province', maxlength: 2, placeholder: 'blank = everywhere' }, (v) => { r.province = v.toUpperCase().slice(0, 2); })),
          stdField('Authority', smallInput(r.authority, { 'aria-label': 'Requirement authority' }, (v) => { r.authority = v; }))),
        h('textarea', { class: 'input', rows: 2, 'aria-label': 'Requirement text', placeholder: 'e.g. Manitoba Hydro requires an underground service disconnect ahead of the meter.', onInput: (e) => { r.text = e.target.value; } }, r.text || ''),
        h('div', { class: 'row' }, ui.button('Remove', { size: 'sm', variant: 'ghost danger', icon: 'trash', onClick: () => { draft.regionRequirements.splice(i, 1); drawReqs(); } }))));
    });
  };
  drawReqs();

  const itemOpts = ui.recordOptions(store.list('items').sort((a, b) => String(a.name).localeCompare(String(b.name))), 'name', '— typed item —');
  const itemCost = new Map(store.list('items').map((i) => [i.id, i.costCents]));
  const matHost = h('div', { class: 'stack' });
  const drawMats = () => {
    ui.clear(matHost);
    draft.materials.forEach((m, i) => {
      const costSpan = h('span', { class: 'num muted' });
      const refreshCost = () => { costSpan.textContent = showMoney && m.itemId && Number.isFinite(Number(itemCost.get(m.itemId))) ? ui.fmtMoney(Math.round(itemCost.get(m.itemId) * (Number(m.qty) || 0))) : ''; };
      const itemSel = h('select', { class: 'input', 'aria-label': 'Price-book item' }, itemOpts.map((o) => h('option', { value: o.value, selected: String(o.value) === String(m.itemId || '') }, o.label)));
      itemSel.addEventListener('change', (e) => { m.itemId = e.target.value || null; refreshCost(); });
      matHost.append(h('div', { class: 'card flat stack' },
        itemSel,
        h('div', { class: 'form-grid' },
          stdField('Name (if not in price book)', smallInput(m.name, { 'aria-label': 'Material name' }, (v) => { m.name = v; })),
          stdField('Qty', smallInput(m.qty, { type: 'number', min: '0', step: 'any', 'aria-label': 'Material qty', inputmode: 'decimal' }, (v) => { m.qty = v === '' ? null : Number(v); refreshCost(); })),
          stdField('Unit', smallInput(m.unit, { 'aria-label': 'Material unit', placeholder: 'e.g. m, ea' }, (v) => { m.unit = v; }))),
        stdField('Note', smallInput(m.note, { 'aria-label': 'Material note' }, (v) => { m.note = v; })),
        h('div', { class: 'row' }, showMoney ? h('span', { class: 'muted' }, 'Cost: ', costSpan) : null, h('span', { class: 'grow' }),
          ui.button('Remove', { size: 'sm', variant: 'ghost danger', icon: 'trash', onClick: () => { draft.materials.splice(i, 1); drawMats(); } }))));
      refreshCost();
    });
  };
  drawMats();

  const breakerTpls = listBreakerTemplates(store.settings());
  const brkHost = h('div', { class: 'stack' });
  const drawBreakers = () => {
    ui.clear(brkHost);
    draft.breakers.forEach((b, i) => {
      const tplSel = h('select', { class: 'input', 'aria-label': 'Breaker template' },
        [h('option', { value: '', selected: !b.templateId }, '— choose a breaker —'), ...breakerTpls.map((t) => h('option', { value: t.id, selected: t.id === b.templateId }, t.label))]);
      tplSel.addEventListener('change', (e) => {
        const t = breakerTpls.find((x) => x.id === e.target.value);
        b.templateId = e.target.value || null;
        if (t) { b.poles = t.poles; b.amps = t.amps; b.breakerType = t.breakerType; b.loadVA = t.loadVA; }
        drawBreakers();
      });
      const typeSel = h('select', { class: 'input', 'aria-label': 'Breaker type' },
        Object.entries(BREAKER_TYPES).map(([k, lbl]) => h('option', { value: k, selected: k === (b.breakerType || 'standard') }, lbl)));
      typeSel.addEventListener('change', (e) => { b.breakerType = e.target.value; });
      brkHost.append(h('div', { class: 'card flat stack' }, tplSel,
        h('div', { class: 'form-grid' },
          stdField('Qty', smallInput(b.qty ?? 1, { type: 'number', min: '1', step: '1', 'aria-label': 'Breaker qty', inputmode: 'numeric' }, (v) => { b.qty = v === '' ? 1 : Math.max(1, Math.round(Number(v))); })),
          stdField('Poles', smallInput(b.poles ?? 1, { type: 'number', min: '1', max: '4', step: '1', 'aria-label': 'Breaker poles', inputmode: 'numeric' }, (v) => { b.poles = v === '' ? 1 : Number(v); })),
          stdField('Amps', smallInput(b.amps, { type: 'number', min: '0', step: 'any', 'aria-label': 'Breaker amps', inputmode: 'decimal' }, (v) => { b.amps = v === '' ? null : Number(v); })),
          stdField('Type', typeSel)),
        stdField('Note', smallInput(b.note, { 'aria-label': 'Breaker note', placeholder: 'e.g. hot tub, EV charger' }, (v) => { b.note = v; })),
        h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Remove', { size: 'sm', variant: 'ghost danger', icon: 'trash', onClick: () => { draft.breakers.splice(i, 1); drawBreakers(); } }))));
    });
  };
  drawBreakers();

  const panelTpls = listPanelTemplates(store.settings());
  const panelSel = h('select', { class: 'input', 'aria-label': 'Panel preset' },
    [h('option', { value: '', selected: !draft.panelTemplateId }, '— no panel preset —'), ...panelTpls.map((p) => h('option', { value: p.id, selected: p.id === draft.panelTemplateId }, p.label))]);
  panelSel.addEventListener('change', (e) => { draft.panelTemplateId = e.target.value || null; });

  const specHost = h('div', { class: 'stack' });
  const drawSpecs = () => {
    ui.clear(specHost);
    draft.specs.forEach((s, i) => {
      specHost.append(h('div', { class: 'row', style: { gap: '8px', alignItems: 'end' } },
        stdField('Label', smallInput(s.label, { 'aria-label': 'Spec label', placeholder: 'e.g. Service, Conductor' }, (v) => { s.label = v; })),
        stdField('Value', smallInput(s.value, { 'aria-label': 'Spec value', placeholder: 'e.g. 100A underground, 2/0 Al teck' }, (v) => { s.value = v; })),
        ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Remove spec', onClick: () => { draft.specs.splice(i, 1); drawSpecs(); } })));
    });
  };
  drawSpecs();

  const taskHost = h('div', { class: 'stack' });
  const drawTasks = () => {
    ui.clear(taskHost);
    draft.tasks.forEach((t, i) => {
      const prioSel = h('select', { class: 'input', 'aria-label': 'Task priority' },
        ['low', 'normal', 'high'].map((p) => h('option', { value: p, selected: p === (t.priority || 'normal') }, p)));
      prioSel.addEventListener('change', (e) => { t.priority = e.target.value; });
      taskHost.append(h('div', { class: 'card flat stack' },
        smallInput(t.title, { 'aria-label': 'Task title', placeholder: 'e.g. Set the underground service disconnect' }, (v) => { t.title = v; }),
        h('div', { class: 'form-grid' },
          stdField('Phase', smallInput(t.phaseName, { 'aria-label': 'Task phase' }, (v) => { t.phaseName = v; })),
          stdField('Est. hours', smallInput(t.estHours, { type: 'number', min: '0', step: 'any', 'aria-label': 'Task hours', inputmode: 'decimal' }, (v) => { t.estHours = v === '' ? null : Number(v); })),
          stdField('Priority', prioSel)),
        h('div', { class: 'row' }, labelCheck('Needs a photo', Boolean(t.requiresPhoto), (c) => { t.requiresPhoto = c; }),
          h('span', { class: 'grow' }), ui.button('Remove', { size: 'sm', variant: 'ghost danger', icon: 'trash', onClick: () => { draft.tasks.splice(i, 1); drawTasks(); } }))));
    });
  };
  function labelCheck(label, value, onChange) {
    const cb = h('input', { type: 'checkbox', checked: value, onChange: (e) => onChange(e.target.checked) });
    return h('label', { class: 'field check' }, cb, h('span', null, label));
  }
  drawTasks();

  const stdBody = h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'form-grid' }, stdField('Job type', jobTypeInput, 'The work-type name people look up'), stdField('Scale', scaleSel)),
      h('div', { class: 'field' }, h('span', null, 'Provinces (none = applies anywhere)'), provinceChips),
      stdField('Authority', authorityInput, 'City of Winnipeg inside Winnipeg, Manitoba Hydro outside'), authorityList),
    ...ui.section('Region requirements', h('div', { class: 'card stack' }, h('p', { class: 'muted' }, 'Rules a region needs that others may not. Leave the province blank to show everywhere.'), reqHost,
      h('div', null, ui.button('Add requirement', { icon: 'plus', onClick: () => { draft.regionRequirements.push({ province: '', authority: '', text: '' }); drawReqs(); } })))),
    ...ui.section('Materials', h('div', { class: 'card stack' }, matHost,
      h('div', null, ui.button('Add material', { icon: 'plus', onClick: () => { draft.materials.push({ itemId: null, name: '', qty: 1, unit: '', note: '' }); drawMats(); } })))),
    ...ui.section('Breakers & panel', h('div', { class: 'card stack' }, stdField('Panel preset', panelSel), brkHost,
      h('div', null, ui.button('Add breaker', { icon: 'plus', onClick: () => { draft.breakers.push({ templateId: null, poles: 1, amps: null, breakerType: 'standard', qty: 1, note: '' }); drawBreakers(); } })))),
    ...ui.section('Specs', h('div', { class: 'card stack' }, specHost,
      h('div', null, ui.button('Add spec', { icon: 'plus', onClick: () => { draft.specs.push({ label: '', value: '' }); drawSpecs(); } })))),
    ...ui.section('Task list', h('div', { class: 'card stack' }, h('p', { class: 'muted' }, 'Seeded as draft work tasks when the office applies this standard to a job.'), taskHost,
      h('div', null, ui.button('Add task', { icon: 'plus', onClick: () => { draft.tasks.push({ title: '', phaseName: '', estHours: null, priority: 'normal', requiresPhoto: false }); drawTasks(); } })))));

  const stdWrap = h('div', { class: 'stack', hidden: !isStd }, stdBody);
  const stdToggle = labelCheckStandard();
  function labelCheckStandard() {
    const cb = h('input', { type: 'checkbox', checked: isStd, onChange: (e) => { isStd = e.target.checked; stdWrap.hidden = !isStd; } });
    return h('label', { class: 'field check' }, cb, h('span', null, 'This is a job standard (work-type playbook)'));
  }

  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'card stack' }, ui.formGrid([title, category]), h('div', { class: 'field' }, h('span', null, 'Who must acknowledge it'), roleBoxes), stdToggle),
    stdWrap,
    ...ui.section('Steps', h('div', { class: 'card stack' }, stepsHost, h('div', null, ui.button('Add step', { icon: 'plus', onClick: () => { draft.steps.push({ text: '' }); drawSteps(); stepsHost.lastChild?.querySelector('textarea')?.focus(); } })))),
    h('p', { class: 'muted' }, sop ? `Changing the title or steps publishes v${sopRev(sop) + 1} and everyone must acknowledge it again.` : ''));

  function save() {
    if (!form.reportValidity()) return;
    const v = ui.readForm(form);
    const steps = draft.steps.map((s) => ({ text: s.text.trim() })).filter((s) => s.text);
    const fields = {
      title: v.title.trim(), category: (v.category || 'General').trim(), steps,
      requiredRoles: Object.keys(ROLES).filter((k) => v['role-' + k]),
    };
    if (isStd) {
      if (!String(draft.jobType || '').trim()) return ui.toast('Give the standard a job type (e.g. RTM hookup)', 'error');
      fields.isStandard = true;
      fields.jobType = String(draft.jobType).trim().slice(0, 120);
      fields.scale = draft.scale || null;
      fields.region = { provinces: [...provinces], authority: String(draft.region.authority || '').trim() };
      fields.regionRequirements = draft.regionRequirements.map((r) => ({ province: (r.province || '').toUpperCase().slice(0, 2), authority: (r.authority || '').trim(), text: (r.text || '').trim() })).filter((r) => r.text);
      fields.materials = draft.materials.map((m) => ({ itemId: m.itemId || null, name: (m.name || '').trim(), qty: Number(m.qty) || 0, unit: (m.unit || '').trim(), note: (m.note || '').trim() })).filter((m) => m.itemId || m.name);
      fields.breakers = draft.breakers.map((b) => ({ templateId: b.templateId || null, poles: Number(b.poles) || 1, amps: b.amps == null || b.amps === '' ? null : Number(b.amps), breakerType: b.breakerType || 'standard', qty: Math.max(1, Math.round(Number(b.qty) || 1)), note: (b.note || '').trim(), loadVA: b.loadVA == null ? null : Number(b.loadVA) }));
      fields.panelTemplateId = draft.panelTemplateId || null;
      fields.specs = draft.specs.map((s) => ({ label: (s.label || '').trim(), value: (s.value || '').trim() })).filter((s) => s.label || s.value);
      fields.tasks = draft.tasks.map((t) => ({ title: (t.title || '').trim(), phaseName: (t.phaseName || '').trim(), taskType: (t.taskType || '').trim(), estHours: t.estHours == null || t.estHours === '' ? null : Number(t.estHours), qty: t.qty == null || t.qty === '' ? null : Number(t.qty), unit: (t.unit || '').trim(), requiresPhoto: Boolean(t.requiresPhoto), minPhotos: t.minPhotos || 1, priority: ['low', 'normal', 'high'].includes(t.priority) ? t.priority : 'normal' })).filter((t) => t.title);
    } else {
      // A SOP that is not (or no longer) a standard: clear the flag but keep any data for later.
      fields.isStandard = false;
    }
    if (!steps.length && !isStd) return ui.toast('Add at least one step', 'error');
    if (!sop) {
      const rec = store.add('sops', { ...fields, revision: 1, acks: [] });
      ui.toast(isStd ? 'Job standard created' : 'SOP created', 'success');
      return nav(`sops/${rec.id}`);
    }
    const changed = JSON.stringify({ t: fields.title, s: steps.map((s) => s.text) }) !== original;
    store.update('sops', sop.id, { ...fields, revision: changed ? sopRev(sop) + 1 : sopRev(sop) },
      { summary: `${fields.title}${changed ? ` → v${sopRev(sop) + 1}` : ''}` });
    ui.toast(changed ? `Published v${sopRev(sop) + 1}` : 'Saved', 'success');
    nav(`sops/${sop.id}`);
  }

  root.append(ui.page({
    title: sop ? `Edit: ${sop.jobType || sop.title}` : (startStandard ? 'New job standard' : 'New SOP'),
    actions: [
      sop ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: async () => { if (await ui.confirmDialog(`Delete "${sop.jobType || sop.title}"?`, { okLabel: 'Delete' })) { store.remove('sops', sop.id); nav('sops'); } } }) : null,
      ui.button('Cancel', { variant: 'ghost', onClick: () => nav(sop ? `sops/${sop.id}` : 'sops') }),
      ui.button(sop ? 'Save' : 'Create', { variant: 'primary', icon: 'save', onClick: save }),
    ].filter(Boolean),
  }, form));
}
