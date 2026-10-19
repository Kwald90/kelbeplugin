// Compliance: permits, inspections, licences/certificates, code checklists.

// Built-in code checklist templates. References are NEC 2023 article numbers;
// local amendments may differ, so the inspector's reading wins.
export const CODE_TEMPLATES = [
  {
    title: 'Residential rough-in (NEC 2023)', items: [
      ['Two or more 20A small-appliance branch circuits for kitchen/dining countertops', '210.11(C)(1)'],
      ['20A laundry circuit and 20A bathroom receptacle circuit', '210.11(C)(2)-(3)'],
      ['GFCI protection: kitchens, baths, laundry, garages, outdoors, basements, within 6 ft of sinks', '210.8(A)'],
      ['AFCI protection on 120V 15/20A branch circuits in habitable rooms, kitchens and laundry', '210.12(A)'],
      ['Receptacle spacing: no point along a wall more than 6 ft from a receptacle', '210.52(A)'],
      ['Countertop receptacle placement per 210.52(C)', '210.52(C)'],
      ['Tamper-resistant receptacles throughout the dwelling', '406.12'],
      ['Box fill calculated and within limits', '314.16'],
      ['Cables secured within 12 in. of boxes and every 4.5 ft (NM)', '334.30'],
      ['Equipment grounding conductors connected in every box', '250.148'],
      ['Lighting outlet and switch in every habitable room, bath, hallway, stair, garage', '210.70'],
    ],
  },
  {
    title: 'Service upgrade', items: [
      ['Service conductors sized for calculated load', '230.42 / 310.12'],
      ['Service disconnect readily accessible, nearest point of entry', '230.70(A)'],
      ['Emergency disconnect outside for one- and two-family dwellings', '230.85'],
      ['Grounding electrode system complete (rods, water pipe, Ufer as present)', '250.50 / 250.52'],
      ['Grounding electrode conductor sized per Table 250.66', '250.66'],
      ['Main bonding jumper installed; neutral and ground separated downstream', '250.24(B) / 250.142'],
      ['Working space: 30 in. wide, 36 in. deep, 6.5 ft headroom', '110.26(A)'],
      ['Surge protective device installed for dwelling service', '230.67'],
      ['Panel directory legible and complete', '408.4(A)'],
      ['Terminations torqued to manufacturer values', '110.14(D)'],
    ],
  },
  {
    title: 'Commercial tenant fit-out', items: [
      ['Load calculation and panel schedules match installed circuits', '220 / 408.4'],
      ['GFCI protection in commercial kitchens, rooftops, outdoors, bathrooms', '210.8(B)'],
      ['Wiring methods suitable for occupancy (MC/EMT; no NM where prohibited)', '334.10 / 334.12'],
      ['Raceways supported and secured', '358.30 / 330.30'],
      ['Egress and exit lighting on unswitched circuits / emergency source', '700.12 / 700.16'],
      ['Working clearance at panels and equipment maintained', '110.26'],
      ['Arc-flash hazard label on equipment', '110.16'],
      ['Available fault current marked at service', '110.24'],
      ['Fire-stopping at rated wall and floor penetrations', '300.21'],
      ['Lighting controls installed per energy code', 'Energy code'],
    ],
  },
  {
    title: 'EV charger install', items: [
      ['Branch circuit rated 125% of the EVSE continuous load', '625.42 / 210.19(A)'],
      ['Individual branch circuit for the EVSE', '625.40'],
      ['GFCI protection for personnel', '625.54'],
      ['Disconnect means for EVSE over 60A or over 150V to ground', '625.43'],
      ['EVSE listed and installed per its instructions', '625.5 / 110.3(B)'],
      ['Load calculation shows capacity, or energy management system in place', '220.87 / 625.42(A)'],
      ['Outdoor locations: equipment rated for the location', '625.50'],
      ['Conductors and overcurrent device torqued and labelled', '110.14(D)'],
    ],
  },
];

const RESULT_TONE = { scheduled: 'info', passed: 'success', failed: 'danger', partial: 'warning' };

export function certStatus(expiry, daysUntil) {
  if (!expiry) return 'valid';
  const d = daysUntil(expiry);
  return d < 0 ? 'expired' : d <= 30 ? 'expiring' : 'valid';
}

/**
 * Shared checklist editor used by Compliance (kind 'code') and Security (kind 'security').
 * Opens a wide sheet that edits items in place.
 */
export function openChecklist(ctx, id) {
  const { store, ui } = ctx;
  const { h } = ui;
  const cl = store.get('checklists', id);
  if (!cl) return;
  const draft = structuredClone(cl);
  const prog = h('div', { class: 'stack' });
  const drawProgress = () => {
    ui.clear(prog);
    const p = checklistProgress(draft);
    prog.append(h('div', { class: 'row' }, h('strong', null, `${p.done} of ${p.total} checked`), h('span', { class: 'grow' }),
      p.fail ? ui.badge(`${p.fail} failed`, 'danger') : null, p.pass ? ui.badge(`${p.pass} pass`, 'success') : null),
    h('div', { class: 'progress' }, h('i', { style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })));
  };
  const STATES = [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A'], ['open', 'Open']];
  const list = h('div', { class: 'check-items' }, draft.items.map((it) => {
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': it.text });
    const note = h('input', { class: 'input', placeholder: 'Note', value: it.note || '', 'aria-label': 'Note', onInput: (e) => { it.note = e.target.value; } });
    const drawSeg = () => {
      ui.clear(seg);
      for (const [v, label] of STATES) {
        seg.append(h('button', { type: 'button', role: 'radio', class: ['seg-btn', v], 'aria-checked': String(it.status === v),
          onClick: () => { it.status = v; drawSeg(); drawProgress(); } }, label));
      }
    };
    drawSeg();
    return h('div', { class: ['check-item', `is-${it.status}`] },
      h('div', { class: 'check-text' }, h('div', null, it.text), it.ref ? h('div', { class: 'meta muted mono' }, it.ref) : null),
      seg, note);
  }));
  drawProgress();
  const save = (complete) => {
    const patch = { items: draft.items };
    if (complete === true) patch.completedAt = new Date().toISOString();
    if (complete === false) patch.completedAt = null;
    store.update('checklists', id, patch, { summary: `${cl.title}${complete ? ' completed' : ''}` });
    ui.toast(complete ? 'Checklist completed' : 'Saved', 'success');
    sheet.close();
  };
  const job = cl.jobId && store.get('jobs', cl.jobId);
  const sheet = ui.openSheet({
    title: cl.title, wide: true,
    body: h('div', { class: 'stack' },
      job ? h('div', { class: 'muted' }, 'Job: ', h('a', { href: `#/jobs/${job.id}` }, `${job.number} · ${job.title}`)) : null,
      cl.completedAt ? ui.badge(`Completed ${ui.fmtDate(cl.completedAt)}`, 'success') : null,
      prog, list),
    actions: [
      ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: async () => { if (await ui.confirmDialog(`Delete "${cl.title}"?`, { okLabel: 'Delete' })) { store.remove('checklists', id); sheet.close(); } } }),
      h('span', { class: 'grow' }),
      cl.completedAt ? ui.button('Reopen', { onClick: () => save(false) }) : ui.button('Mark complete', { icon: 'check', onClick: () => save(true) }),
      ui.button('Save', { variant: 'primary', onClick: () => save() }),
    ],
  });
}

export function checklistProgress(cl) {
  const items = cl.items || [];
  const c = (s) => items.filter((i) => i.status === s).length;
  const total = items.length;
  return { total, pass: c('pass'), fail: c('fail'), na: c('na'), open: c('open'), done: total - c('open') };
}

/** Card grid of checklists, used by both modules. */
export function checklistCards(ctx, rows, emptyNode) {
  const { ui, store } = ctx;
  const { h } = ui;
  if (!rows.length) return emptyNode;
  return h('div', { class: 'grid' }, rows.map((cl) => {
    const p = checklistProgress(cl);
    const job = cl.jobId && store.get('jobs', cl.jobId);
    return h('div', { class: 'card click', tabindex: 0, onClick: () => openChecklist(ctx, cl.id), onKeydown: (e) => { if (e.key === 'Enter') openChecklist(ctx, cl.id); } },
      h('div', { class: 'row' }, cl.completedAt ? ui.badge('Complete', 'success') : ui.badge('In progress', 'info'), h('span', { class: 'grow' }),
        p.fail ? ui.badge(`${p.fail} failed`, 'danger') : null),
      h('h3', { style: { marginTop: '8px' } }, cl.title),
      job ? h('div', { class: 'meta muted' }, `${job.number} · ${job.title}`) : null,
      h('div', { class: 'meta muted', style: { margin: '6px 0' } }, `${p.done}/${p.total} checked`),
      h('div', { class: 'progress' }, h('i', { style: { width: `${p.total ? (p.done / p.total) * 100 : 0}%` } })));
  }));
}

/** Pick a template (and optionally a job), create the checklist, open it. */
export function newChecklistFromTemplate(ctx, kind, templates, defaults = {}) {
  const { store, ui } = ctx;
  const jobs = store.list('jobs');
  ui.formSheet({
    title: kind === 'code' ? 'New code checklist' : 'New security audit',
    submitLabel: 'Create',
    fields: [
      { label: 'Template', name: 'template', type: 'select', options: templates.map((t, i) => ({ value: i, label: t.title })), span: true },
      kind === 'code' ? { label: 'Job', name: 'jobId', type: 'select', value: defaults.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`), span: true } : null,
    ].filter(Boolean),
    onSubmit: (v) => {
      const t = templates[Number(v.template)];
      const rec = store.add('checklists', {
        kind, title: t.title, jobId: v.jobId || null, completedAt: null,
        items: t.items.map(([text, ref]) => ({ text, ref, status: 'open', note: '' })),
      });
      setTimeout(() => openChecklist(ctx, rec.id), 50);
    },
  });
}

export default {
  id: 'compliance',
  title: 'Compliance',
  icon: 'shield-check',
  group: 'field',
  perm: 'compliance',
  render(root, ctx) {
    const { store, ui, query } = ctx;
    const { h } = ui;
    let tab = query.tab || 'permits';
    const jobFilter = query.jobId || '';
    const statsHost = h('div', { class: 'grid stat-grid' });
    const tabsHost = h('div', { class: 'row', style: { marginBottom: '16px' } });
    const body = h('div');
    const job = jobFilter && store.get('jobs', jobFilter);
    const jobLabel = (id) => { const j = id && store.get('jobs', id); return j ? h('a', { href: `#/jobs/${j.id}`, onClick: (e) => e.stopPropagation() }, `${j.number} · ${j.title}`) : h('span', { class: 'muted' }, '—'); };
    const jobOpts = () => ui.recordOptions(store.list('jobs'), (j) => `${j.number} · ${j.title}`);
    const inJob = (r) => !jobFilter || r.jobId === jobFilter;

    const drawStats = () => {
      ui.clear(statsHost);
      const permitsOpen = store.count('permits', (p) => p.status !== 'closed' && inJob(p));
      const t = ui.today(), wk = ui.today(7);
      const inspWeek = store.count('inspections', (i) => i.result === 'scheduled' && i.date >= t && i.date <= wk && inJob(i));
      const expiring = allCerts().filter((c) => c.status !== 'valid').length;
      const failed = store.list('checklists', (c) => c.kind === 'code' && inJob(c)).reduce((s, c) => s + checklistProgress(c).fail, 0)
        + store.count('inspections', (i) => i.result === 'failed' && inJob(i));
      statsHost.append(
        ui.stat({ label: 'Permits open', value: permitsOpen }),
        ui.stat({ label: 'Inspections next 7 days', value: inspWeek, tone: inspWeek ? 'accent' : null }),
        ui.stat({ label: 'Certs expiring / expired', value: expiring, tone: expiring ? 'danger' : 'success' }),
        ui.stat({ label: 'Failed items', value: failed, tone: failed ? 'danger' : 'success' }));
    };

    function allCerts() {
      const emps = store.list('employees');
      const name = (id) => emps.find((e) => e.id === id)?.name || '—';
      const rows = store.list('certifications').map((c) => ({ ...c, holder: c.employeeId ? name(c.employeeId) : 'Company', source: 'cert' }));
      for (const e of emps) {
        if (e.active === false || !e.licenceNo) continue;
        rows.push({ id: 'lic-' + e.id, employeeId: e.id, holder: e.name, name: 'Electrical licence', issuer: 'State licensing board', number: e.licenceNo, expiry: e.licenceExpiry, source: 'employee' });
      }
      for (const r of rows) { r.status = certStatus(r.expiry, ui.daysUntil); r.days = r.expiry ? ui.daysUntil(r.expiry) : Infinity; }
      return rows.sort((a, b) => a.days - b.days);
    }

    function editPermit(p) {
      ui.formSheet({
        title: p ? `Permit ${p.number}` : 'New permit',
        fields: [
          { label: 'Job', name: 'jobId', type: 'select', value: p?.jobId ?? jobFilter, options: jobOpts(), span: true },
          { label: 'Permit number', name: 'number', value: p?.number, required: true },
          { label: 'Authority', name: 'authority', value: p?.authority ?? 'Springfield Building Dept' },
          { label: 'Type', name: 'type', value: p?.type ?? 'Electrical' },
          { label: 'Status', name: 'status', type: 'select', value: p?.status ?? 'applied', options: ['applied', 'issued', 'closed'] },
          { label: 'Applied', name: 'appliedDate', type: 'date', value: p?.appliedDate ?? ui.today() },
          { label: 'Issued', name: 'issuedDate', type: 'date', value: p?.issuedDate },
          { label: 'Expires', name: 'expiryDate', type: 'date', value: p?.expiryDate },
        ],
        danger: p ? { label: 'Delete', onClick: () => store.remove('permits', p.id) } : null,
        onSubmit: (v) => { v.jobId = v.jobId || null; if (p) store.update('permits', p.id, v); else store.add('permits', v); ui.toast('Permit saved', 'success'); },
      });
    }

    function editInspection(i) {
      const permits = store.list('permits');
      ui.formSheet({
        title: i ? 'Inspection' : 'Schedule inspection',
        fields: [
          { label: 'Job', name: 'jobId', type: 'select', value: i?.jobId ?? jobFilter, options: jobOpts(), span: true },
          { label: 'Permit', name: 'permitId', type: 'select', value: i?.permitId ?? '', options: ui.recordOptions(permits, (p) => `${p.number} · ${p.type}`) },
          { label: 'Type', name: 'type', type: 'select', value: i?.type ?? 'rough-in', options: ['rough-in', 'service', 'final', 'other'] },
          { label: 'Date', name: 'date', type: 'date', value: i?.date ?? ui.today(1), required: true },
          { label: 'Result', name: 'result', type: 'select', value: i?.result ?? 'scheduled', options: ['scheduled', 'passed', 'partial', 'failed'] },
          { label: 'Inspector', name: 'inspector', value: i?.inspector },
          { label: 'Notes / corrections', name: 'notes', type: 'textarea', value: i?.notes, span: true },
        ],
        danger: i ? { label: 'Delete', onClick: () => store.remove('inspections', i.id) } : null,
        onSubmit: (v) => { v.jobId = v.jobId || null; v.permitId = v.permitId || null; if (i) store.update('inspections', i.id, v); else store.add('inspections', v); ui.toast('Inspection saved', 'success'); },
      });
    }

    function editCert(c) {
      if (c?.source === 'employee') { ui.toast('Edit licences on the employee record', 'info'); return ctx.nav('employees'); }
      ui.formSheet({
        title: c ? c.name : 'Add certificate',
        fields: [
          { label: 'Name', name: 'name', value: c?.name, required: true, span: true, placeholder: 'e.g. General liability insurance, OSHA 30' },
          { label: 'Held by', name: 'employeeId', type: 'select', value: c?.employeeId ?? '', options: ui.recordOptions(store.list('employees', (e) => e.active !== false), 'name', 'Company-wide') },
          { label: 'Issuer', name: 'issuer', value: c?.issuer },
          { label: 'Number', name: 'number', value: c?.number },
          { label: 'Expires', name: 'expiry', type: 'date', value: c?.expiry },
        ],
        danger: c ? { label: 'Delete', onClick: () => store.remove('certifications', c.id) } : null,
        onSubmit: (v) => { v.employeeId = v.employeeId || null; if (c) store.update('certifications', c.id, v); else store.add('certifications', v); ui.toast('Saved', 'success'); },
      });
    }

    const TABS = [
      { id: 'permits', label: 'Permits' }, { id: 'inspections', label: 'Inspections' },
      { id: 'certs', label: 'Licences & certificates' }, { id: 'checklists', label: 'Code checklists' },
    ];
    const ADD = {
      permits: ['New permit', () => editPermit(null)],
      inspections: ['Schedule inspection', () => editInspection(null)],
      certs: ['Add certificate', () => editCert(null)],
      checklists: ['New checklist', () => newChecklistFromTemplate(ctx, 'code', CODE_TEMPLATES, { jobId: jobFilter })],
    };

    const draw = () => {
      drawStats();
      ui.clear(tabsHost);
      tabsHost.append(ui.tabs(TABS, tab, (t) => { tab = t; draw(); }), h('span', { class: 'grow' }), ui.button(ADD[tab][0], { variant: 'primary', icon: 'plus', onClick: ADD[tab][1] }));
      ui.clear(body);
      if (tab === 'permits') {
        const rows = store.list('permits', inJob);
        body.append(ui.table({
          columns: [
            { key: 'number', label: 'Permit', render: (p) => h('strong', { class: 'mono nowrap' }, p.number), sort: (p) => p.number },
            { key: 'job', label: 'Job', render: (p) => jobLabel(p.jobId) },
            { key: 'type', label: 'Type' },
            { key: 'authority', label: 'Authority' },
            { key: 'status', label: 'Status', render: (p) => ui.statusBadge(p.status), sort: (p) => p.status },
            { key: 'issuedDate', label: 'Issued', render: (p) => ui.fmtDate(p.issuedDate), sort: (p) => p.issuedDate || '' },
            { key: 'expiryDate', label: 'Expires', render: (p) => { const d = p.expiryDate ? ui.daysUntil(p.expiryDate) : null; return h('span', { class: d != null && d < 30 && p.status !== 'closed' ? 'text-danger' : null }, ui.fmtDate(p.expiryDate)); }, sort: (p) => p.expiryDate || '9' },
          ],
          rows, onRowClick: editPermit,
          empty: ui.empty({ icon: 'file-text', title: 'No permits', text: 'Track every permit from application to close.', action: ui.button('New permit', { variant: 'primary', icon: 'plus', onClick: () => editPermit(null) }) }),
        }));
      } else if (tab === 'inspections') {
        const t = ui.today();
        const rows = store.list('inspections', inJob).sort((a, b) => {
          const ua = a.result === 'scheduled' && a.date >= t, ub = b.result === 'scheduled' && b.date >= t;
          if (ua !== ub) return ua ? -1 : 1;
          return ua ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
        });
        const permits = Object.fromEntries(store.list('permits').map((p) => [p.id, p]));
        body.append(ui.table({
          columns: [
            { key: 'date', label: 'Date', render: (i) => h('span', null, ui.fmtDate(i.date), i.result === 'scheduled' && i.date < t ? h('span', { class: 'text-danger' }, ' · result missing') : null) },
            { key: 'type', label: 'Type', render: (i) => i.type.replace('-', ' ') },
            { key: 'job', label: 'Job', render: (i) => jobLabel(i.jobId) },
            { key: 'permit', label: 'Permit', render: (i) => permits[i.permitId]?.number || '—' },
            { key: 'inspector', label: 'Inspector' },
            { key: 'result', label: 'Result', render: (i) => ui.badge(i.result, RESULT_TONE[i.result] || 'neutral') },
          ],
          rows, onRowClick: editInspection,
          empty: ui.empty({ icon: 'calendar', title: 'No inspections', action: ui.button('Schedule inspection', { variant: 'primary', icon: 'plus', onClick: () => editInspection(null) }) }),
        }));
      } else if (tab === 'certs') {
        const rows = allCerts();
        const label = { valid: 'valid', expiring: 'expiring', expired: 'expired' };
        body.append(ui.table({
          columns: [
            { key: 'name', label: 'Licence / certificate', render: (c) => h('strong', null, c.name) },
            { key: 'holder', label: 'Held by' },
            { key: 'issuer', label: 'Issuer' },
            { key: 'number', label: 'Number', render: (c) => h('span', { class: 'mono' }, c.number || '—') },
            { key: 'expiry', label: 'Expires', render: (c) => h('span', null, ui.fmtDate(c.expiry), c.expiry ? h('span', { class: 'muted' }, c.days < 0 ? ` · ${-c.days}d ago` : ` · ${c.days}d`) : null) },
            { key: 'status', label: 'Status', render: (c) => ui.statusBadge(label[c.status]) },
          ],
          rows, onRowClick: editCert,
          empty: ui.empty({ icon: 'id-card', title: 'No licences or certificates', action: ui.button('Add certificate', { variant: 'primary', icon: 'plus', onClick: () => editCert(null) }) }),
        }));
      } else {
        const rows = store.list('checklists', (c) => c.kind === 'code' && inJob(c));
        body.append(checklistCards(ctx, rows, ui.empty({ icon: 'check', title: 'No code checklists', text: 'Start one from a template: rough-in, service upgrade, fit-out, EV charger.',
          action: ui.button('New checklist', { variant: 'primary', icon: 'plus', onClick: ADD.checklists[1] }) })));
      }
    };

    root.append(ui.page({
      title: 'Compliance',
      subtitle: job ? h('span', null, 'Filtered to ', h('a', { href: `#/jobs/${job.id}` }, `${job.number} · ${job.title}`), ' · ', h('a', { href: '#/compliance' }, 'show all')) : 'Permits, inspections, licences and code checklists',
    }, statsHost, tabsHost, body));
    draw();
    const offs = ['permits', 'inspections', 'certifications', 'checklists', 'employees'].map((c) => store.on(c, draw));
    return () => offs.forEach((f) => f());
  },
};
