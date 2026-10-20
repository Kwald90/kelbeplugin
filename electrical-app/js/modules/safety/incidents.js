// Incidents and near misses: a quick report from the phone, then (managers) the
// investigation with 5 whys, corrective actions, the "reportable?" prompt by province
// and status. Medical details are visible to managers only (the server strips them too).
import { CATEGORIES, INJURY_TYPES, BODY_PARTS, INCIDENT_STATUSES } from '../../lib/safety.js';
import { reportableFor } from '../../lib/safety-reporting.js';
import { photoStrip } from '../../lib/safety-capture.js';
import { provinceName } from '../../lib/tax.js';
import { me, jobOptions, jobLabel, nameOf, employeeOptions, chips, seg, backBtn, notifySafety, emptyNoEmployee } from './common.js';
import { newAction, actionList } from './actions.js';

const TREATMENTS = [['none', 'No treatment'], ['first-aid', 'First aid on site'], ['medical-aid', 'Doctor / clinic (health care)'], ['lost-time', 'Time off work'], ['hospital', 'Admitted to hospital'], ['fatality', 'Fatality']];
const STATUS_TONE = { reported: 'warning', investigating: 'info', actions: 'accent', closed: 'success' };
const PRIVACY = 'Medical details are visible to managers only.';

const localInput = (iso) => { const d = iso ? new Date(iso) : new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function incidentsList(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const rows = store.list('incidents').sort((a, b) => String(b.occurredAt || b.createdAt).localeCompare(String(a.occurredAt || a.createdAt)));
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }),
    ui.button('Report a near miss', { icon: 'alert', href: '#/safety/incidents/new?kind=near-miss' }),
    ui.button('Report an incident', { variant: 'primary', icon: 'plus', href: '#/safety/incidents/new?kind=incident' })));
  el.append(rows.length ? h('div', { class: 'list' }, rows.map((r) => h('a', { class: 'list-row click', href: `#/safety/incidents/${r.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, r.title || (r.description || '').slice(0, 80) || 'Report'),
      h('div', { class: 'meta' }, [ui.fmtDateTime(r.occurredAt), jobLabel(store.get('jobs', r.jobId)), r.location, `by ${nameOf(store, r.reportedBy)}`].filter(Boolean).join(' · '))),
    ui.badge(r.kind === 'near-miss' ? 'near miss' : 'incident', r.kind === 'near-miss' ? 'info' : 'danger'),
    ui.badge(r.status || 'reported', STATUS_TONE[r.status] || 'warning'))))
    : ui.empty({ icon: 'alert', title: 'No reports yet', text: 'Report near misses as well as injuries: every one fixed is an injury that doesn\'t happen.' }));
}

/** #/safety/incidents/new?kind=near-miss|incident */
export function incidentForm(root, ctx) {
  const { store, ui, nav, query } = ctx;
  const { h } = ui;
  const person = me(ctx);
  if (!person.id) { root.append(ui.page({ title: 'Report' }, emptyNoEmployee(ui))); return; }
  let kind = query.kind === 'incident' ? 'incident' : 'near-miss';
  const photos = [];
  const people = new Set();
  const parts = new Set();
  const witnesses = [];
  const flags = { electricalContact: false, fire: false, structuralFailure: false, dangerousOccurrence: false, hospital: false, critical: false };

  const form = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, ui.formGrid([
    { label: 'What happened', name: 'description', type: 'textarea', rows: 4, required: true, span: true, placeholder: 'Plain words: what you saw, what could have happened' },
    { label: 'Type', name: 'category', type: 'select', value: 'other', options: CATEGORIES.map(([value, label]) => ({ value, label })) },
    { label: 'When', name: 'occurredAt', type: 'datetime-local', value: localInput(), required: true },
    { label: 'Job', name: 'jobId', type: 'select', value: query.jobId || '', options: jobOptions(ctx) },
    { label: 'Where on site', name: 'location', placeholder: 'e.g. Stairwell B, 3rd floor' },
    { label: 'What was done right away', name: 'immediateActions', type: 'textarea', rows: 2, span: true, placeholder: 'Area barricaded, power locked out, first aid given...' },
  ]));

  const injuredHost = h('div', { class: 'stack', hidden: true });
  const medForm = h('div', { class: 'stack' },
    ui.formGrid([
      { label: 'Injury type', name: 'injuryType', type: 'select', options: ['', ...INJURY_TYPES] },
      { label: 'Treatment', name: 'treatment', type: 'select', value: 'first-aid', options: TREATMENTS.map(([value, label]) => ({ value, label })) },
    ]),
    h('div', { class: 'field' }, h('span', null, 'Body part'), chips(ui, BODY_PARTS.map((b) => [b, b]), parts, null, 'Body part')),
    h('p', { class: 'muted sf-small' }, ui.icon('lock', 14), ' ', PRIVACY));
  injuredHost.append(medForm);
  const injured = seg(ui, [['no', 'No'], ['yes', 'Yes']], 'no', (v) => { injuredHost.hidden = v !== 'yes'; }, { label: 'Was anyone hurt?' });

  const peopleHost = chips(ui, store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((e) => [e.id, e.name]), people, null, 'People involved');
  const witnessHost = h('div', { class: 'stack' });
  const drawWitnesses = () => {
    ui.clear(witnessHost);
    witnesses.forEach((w, i) => witnessHost.append(h('div', { class: 'sf-witness' },
      h('input', { class: 'input', placeholder: 'Name', 'aria-label': `Witness ${i + 1} name`, value: w.name, onInput: (e) => { w.name = e.target.value; } }),
      h('input', { class: 'input', type: 'tel', placeholder: 'Phone', 'aria-label': `Witness ${i + 1} phone`, value: w.phone, onInput: (e) => { w.phone = e.target.value; } }),
      h('textarea', { class: 'input', rows: 2, placeholder: 'What they saw', 'aria-label': `Witness ${i + 1} statement`, onInput: (e) => { w.statement = e.target.value; } }, w.statement))));
    witnessHost.append(ui.button('Add witness', { size: 'sm', icon: 'plus', onClick: () => { witnesses.push({ name: '', phone: '', statement: '' }); drawWitnesses(); } }));
  };
  drawWitnesses();

  const flagBoxes = h('div', { class: 'sf-flags' }, [
    ['electricalContact', 'Electrical contact or shock'], ['fire', 'Fire or explosion'], ['structuralFailure', 'Collapse or structural failure'],
    ['dangerousOccurrence', 'Fall from height, crane/hoist or other dangerous occurrence'], ['hospital', 'Someone went to hospital'], ['critical', 'Serious or life-threatening injury'],
  ].map(([k, label]) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', onChange: (e) => { flags[k] = e.target.checked; } }), h('span', null, label))));

  const kindSeg = seg(ui, [['near-miss', 'Near miss'], ['incident', 'Incident']], kind, (v) => { kind = v; injuredWrap.hidden = v !== 'incident'; title.textContent = v === 'incident' ? 'Report an incident' : 'Report a near miss'; }, { label: 'Kind' });
  const injuredWrap = h('div', { class: 'card stack', hidden: kind !== 'incident' }, h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Was anyone hurt?'), injured), injuredHost);
  const title = h('span', null, kind === 'incident' ? 'Report an incident' : 'Report a near miss');

  function submit() {
    if (!form.reportValidity()) return;
    const v = ui.readForm(form);
    const med = ui.readForm(medForm);
    const hurt = kind === 'incident' && !injuredHost.hidden;
    const rec = store.add('incidents', {
      kind, category: v.category, title: v.description.trim().split('\n')[0].slice(0, 120), description: v.description.trim(),
      occurredAt: new Date(v.occurredAt).toISOString(), jobId: v.jobId || null, location: v.location,
      province: store.settings().company?.province || null,
      reportedBy: person.id, reportedAt: new Date().toISOString(),
      people: [...people].map((id) => ({ employeeId: id, name: nameOf(store, id, ''), role: 'involved' })),
      witnesses: witnesses.filter((w) => w.name.trim()),
      immediateActions: v.immediateActions, photos, status: 'reported',
      flags: kind === 'incident' ? flags : {},
      ...(hurt ? { medical: { injured: true, injuryType: med.injuryType, bodyParts: [...parts], treatment: med.treatment } } : {}),
    });
    notifySafety(ctx, kind === 'incident' ? 'incident' : 'near-miss', `${person.name} reported: ${rec.title}`, rec.id);
    ui.toast('Report filed. Thank you for speaking up.', 'success', 3500);
    nav(`safety/incidents/${rec.id}`);
  }

  root.append(ui.page({ title: h('span', null, title), subtitle: `${person.name} · offline is fine, it syncs when you're back`, actions: [backBtn(ui, '#/safety?tab=incidents')] },
    h('div', { class: 'row sf-gap' }, kindSeg),
    h('div', { class: 'card' }, form),
    injuredWrap,
    ...ui.section('People involved', h('div', { class: 'card' }, peopleHost)),
    ...ui.section('Witnesses', h('div', { class: 'card' }, witnessHost)),
    ...ui.section('Photos', h('div', { class: 'card' }, photoStrip({ photos, max: 8, toast: ui.toast }))),
    h('div', { class: 'card stack sf-gap', hidden: false }, h('strong', null, 'Did any of these happen? (incidents)'), flagBoxes),
    h('div', { class: 'row sf-actions' }, h('span', { class: 'grow' }), ui.button('File report', { variant: 'primary', size: 'lg', icon: 'send', onClick: submit }))));
}

/** #/safety/incidents/<id> */
export function incidentView(root, ctx, id) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const manager = auth.isManager();
  const host = h('div');
  root.append(host);
  const draw = () => {
    ui.clear(host);
    const r = store.get('incidents', id);
    if (!r) { host.append(ui.page({ title: 'Report' }, ui.empty({ icon: 'alert', title: 'Not found', action: ui.button('Safety', { href: '#/safety?tab=incidents' }) }))); return; }
    const job = r.jobId && store.get('jobs', r.jobId);
    const actions = store.list('correctiveActions', (a) => a.sourceType === 'incident' && a.sourceId === r.id);
    host.append(ui.page({
      title: r.title || 'Report',
      subtitle: [r.kind === 'near-miss' ? 'Near miss' : 'Incident', ui.fmtDateTime(r.occurredAt), jobLabel(job), r.location].filter(Boolean).join(' · '),
      actions: [backBtn(ui, '#/safety?tab=incidents'), ui.button('Print', { icon: 'printer', onClick: () => print() })],
    },
    h('div', { class: 'row sf-gap' }, ui.badge(r.status || 'reported', STATUS_TONE[r.status] || 'warning'), h('span', { class: 'muted' }, `Reported by ${nameOf(store, r.reportedBy)} · ${ui.fmtDateTime(r.reportedAt)}`), h('span', { class: 'grow' }),
      manager ? statusSelect(ctx, r) : null),
    h('div', { class: 'card stack' }, h('p', { class: 'sf-pre' }, r.description || ''),
      r.immediateActions ? h('div', null, h('strong', null, 'Done right away: '), r.immediateActions) : null,
      (r.people || []).length ? h('div', null, h('strong', null, 'People involved: '), r.people.map((p) => p.name || nameOf(store, p.employeeId)).join(', ')) : null),
    (r.witnesses || []).length ? ui.section('Witnesses', h('div', { class: 'list' }, r.witnesses.map((w) => h('div', { class: 'list-row' }, h('div', { class: 'grow' },
      h('div', { class: 'title' }, w.name, w.phone ? [' · ', h('a', { href: 'tel:' + w.phone }, w.phone)] : null), w.statement ? h('div', { class: 'meta sf-pre' }, w.statement) : null))))) : null,
    (r.photos || []).length ? ui.section('Photos', photoStrip({ photos: r.photos, readOnly: true })) : null,
    ...ui.section('Medical', medicalSection(ctx, r)),
    manager ? ui.section('Reportable?', reportablePanel(ctx, r)) : null,
    manager ? ui.section('Investigation', investigation(ctx, r)) : null,
    ...ui.section(`Corrective actions (${actions.length})`, actionList(ctx, actions, 'None yet.'),
      h('div', { class: 'row sf-pad-top no-print' }, ui.button('Add corrective action', { size: 'sm', icon: 'plus', onClick: () => newAction(ctx, { sourceType: 'incident', sourceId: r.id, jobId: r.jobId || null }, () => {
        if (manager && (r.status || 'reported') !== 'closed') store.update('incidents', r.id, { status: 'actions' });
      }) }))),
    ));
  };
  draw();
  const offs = ['incidents', 'correctiveActions'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

function statusSelect(ctx, r) {
  const { store, ui } = ctx;
  return ui.h('select', { class: 'input sf-status', 'aria-label': 'Status', onChange: (e) => {
    const status = e.target.value;
    store.update('incidents', r.id, { status, closedAt: status === 'closed' ? new Date().toISOString() : null });
    ui.toast(`Status: ${status}`, 'success');
  } }, INCIDENT_STATUSES.map((s) => ui.h('option', { value: s, selected: (r.status || 'reported') === s }, s)));
}

function medicalSection(ctx, r) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  if (!auth.isManager()) return h('p', { class: 'muted' }, ui.icon('lock', 14), ' ', PRIVACY);
  const m = r.medical || {};
  const form = h('form', { class: 'stack' }, ui.formGrid([
    { label: 'Injured', name: 'injured', type: 'checkbox', value: Boolean(m.injured) },
    { label: 'Injury type', name: 'injuryType', type: 'select', value: m.injuryType || '', options: ['', ...INJURY_TYPES] },
    { label: 'Body parts (comma separated)', name: 'bodyParts', value: (m.bodyParts || []).join(', ') },
    { label: 'Treatment', name: 'treatment', type: 'select', value: m.treatment || 'none', options: TREATMENTS.map(([value, label]) => ({ value, label })) },
    { label: 'Days away', name: 'daysAway', type: 'number', min: 0, value: m.daysAway ?? '' },
    { label: 'Modified work', name: 'modifiedWork', type: 'checkbox', value: Boolean(m.modifiedWork) },
    { label: 'Hospital / clinic', name: 'hospital', value: m.hospital || '' },
    { label: 'WCB claim number', name: 'claimNumber', value: m.claimNumber || '' },
    { label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: m.notes || '', span: true },
  ]));
  return h('div', { class: 'card stack sf-medical' }, h('p', { class: 'muted sf-small' }, ui.icon('lock', 14), ' ', PRIVACY), form,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save medical details', { size: 'sm', onClick: () => {
      const v = ui.readForm(form);
      store.update('incidents', r.id, { medical: { ...m, ...v, bodyParts: String(v.bodyParts || '').split(',').map((s) => s.trim()).filter(Boolean), daysAway: v.daysAway == null ? null : Math.max(0, Math.round(v.daysAway)) } }, { summary: 'medical details updated' });
      ui.toast('Saved', 'success');
    } })));
}

function reportablePanel(ctx, r) {
  const { store, ui } = ctx;
  const { h } = ui;
  const province = r.province || store.settings().company?.province;
  const rep = reportableFor(r, province);
  const reporting = r.reporting || {};
  const mark = (field, label) => (reporting[field]
    ? ui.badge(`${label} ${ui.fmtDateTime(reporting[field])}`, 'success')
    : ui.button(`Mark ${label.toLowerCase()}`, { size: 'sm', icon: 'check', onClick: () => store.update('incidents', r.id, { reporting: { ...reporting, [field]: new Date().toISOString() } }) }));
  if (!rep.covered) return h('div', { class: 'card' }, `Reporting rules for ${province || 'your province'} aren't in Fishtape yet. Check with the provincial OHS regulator and workers' compensation board.`);
  const due = (iso, hours) => (hours === 0 ? 'Immediately' : `By ${ui.fmtDateTime(iso)}`);
  return h('div', { class: ['card', 'stack', 'sf-report', rep.any ? 'reportable' : null] },
    h('div', { class: 'row' }, rep.any ? ui.badge('Likely reportable', 'danger') : ui.badge('Not reportable on these facts', 'neutral'),
      h('span', { class: 'muted' }, provinceName(province)), h('span', { class: 'grow' }),
      rep.regulator?.phone ? h('a', { class: 'btn sm', href: 'tel:' + rep.regulator.phone.replace(/[^0-9+]/g, '') }, `Call ${rep.regulator.phone}`) : null),
    rep.notify.length ? h('div', { class: 'list' }, rep.notify.map((n) => h('div', { class: 'list-row' }, h('div', { class: 'grow' },
      h('div', { class: 'title' }, `${rep.regulator.name}: ${n.timeline}`),
      h('div', { class: 'meta' }, n.what), h('div', { class: 'meta mono' }, n.ref, n.verify ? h('span', { class: 'text-danger' }, ' · VERIFY with the regulator') : null)),
    h('span', { class: 'muted nowrap' }, due(n.dueAt, n.hours))))) : null,
    rep.wcb ? h('div', { class: 'list-row' }, h('div', { class: 'grow' },
      h('div', { class: 'title' }, `${rep.wcb.name} ${rep.wcb.form}: ${rep.wcb.deadline}`), h('div', { class: 'meta' }, rep.wcb.what),
      h('div', { class: 'meta' }, h('a', { href: rep.wcb.url, target: '_blank', rel: 'noopener' }, 'Report online'), rep.wcb.verify ? h('span', { class: 'text-danger' }, ' · VERIFY with the board') : null)),
    h('span', { class: 'muted nowrap' }, `By ${ui.fmtDate(rep.wcb.dueAt)}`)) : null,
    h('div', { class: 'row' }, mark('regulatorNotifiedAt', 'Regulator notified'), mark('wcbReportedAt', 'WCB reported'), rep.regulator ? h('a', { href: rep.regulator.url, target: '_blank', rel: 'noopener', class: 'sf-small' }, 'Regulator page') : null),
    h('p', { class: 'muted sf-small' }, 'A prompt from the facts entered, not legal advice. When in doubt, call the regulator. Sources: docs/safety/README.md.'));
}

function investigation(ctx, r) {
  const { store, ui } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const inv = structuredClone(r.investigation || { whys: ['', '', '', '', ''], rootCause: '', findings: '', factors: [] });
  while ((inv.whys || []).length < 5) inv.whys.push('');
  const whys = inv.whys.map((w, i) => h('label', { class: 'field' }, h('span', null, i === 0 ? 'Why did it happen?' : `Why? (${i + 1})`),
    h('input', { class: 'input', value: w, onInput: (e) => { inv.whys[i] = e.target.value; } })));
  const root = h('textarea', { class: 'input', rows: 2, 'aria-label': 'Root cause', onInput: (e) => { inv.rootCause = e.target.value; } }, inv.rootCause || '');
  const findings = h('textarea', { class: 'input', rows: 3, 'aria-label': 'Findings', onInput: (e) => { inv.findings = e.target.value; } }, inv.findings || '');
  const save = (complete) => {
    const next = { ...inv, by: inv.by || person.id, startedAt: inv.startedAt || new Date().toISOString(), ...(complete ? { completedAt: new Date().toISOString() } : {}) };
    const status = (r.status || 'reported') === 'reported' ? 'investigating' : r.status;
    store.update('incidents', r.id, { investigation: next, status }, { summary: complete ? 'investigation completed' : 'investigation saved' });
    ui.toast(complete ? 'Investigation completed' : 'Saved', 'success');
  };
  return h('div', { class: 'card stack' },
    inv.completedAt ? ui.badge(`Completed ${ui.fmtDate(inv.completedAt)} by ${nameOf(store, inv.by)}`, 'success') : null,
    h('p', { class: 'muted sf-small' }, '5 whys: ask "why" until you reach something the company can fix (a system, not a person).'),
    ...whys,
    h('label', { class: 'field' }, h('span', null, 'Root cause'), root),
    h('label', { class: 'field' }, h('span', null, 'Findings'), findings),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save', { size: 'sm', onClick: () => save(false) }), ui.button('Complete investigation', { size: 'sm', variant: 'primary', icon: 'check', onClick: () => save(true) })));
}
