// Field level hazard assessment: one worker, one job, one day. Hazards with controls, PPE,
// "stop work", the worker's signature and the foreman's review sign-off.
import { HAZARDS, PPE, newFlha, copyFlha, isSigned, uncontrolledHazards, hazardLabel, ppeLabel, flhaFor } from '../../lib/safety.js';
import { signaturePad, signatureOf } from '../../lib/safety-capture.js';
import { me, jobOptions, jobLabel, nameOf, seg, chips, signatureView, backBtn, notifySafety, emptyNoEmployee, ICON_STOP } from './common.js';

/** #/safety/flha/new?jobId=&copy=<id>  or  #/safety/flha/<id> */
export function flhaView(root, ctx, id) {
  const { store, ui, nav, auth, query } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const manager = auth.isManager();
  let rec = id && id !== 'new' ? store.get('flhas', id) : null;
  if (id && id !== 'new' && !rec) {
    root.append(ui.page({ title: 'Hazard assessment' }, ui.empty({ icon: 'alert', title: 'Not found', action: ui.button('Safety', { href: '#/safety' }) })));
    return;
  }
  if (!rec && !person.id) { root.append(ui.page({ title: 'Hazard assessment' }, emptyNoEmployee(ui))); return; }

  if (!rec) {
    const day = query.date || ui.today();
    const jobId = query.jobId || null;
    // One FLHA per worker, job and day: open the existing one instead of making a second.
    const existing = jobId && !query.copy ? flhaFor(person.id, jobId, day, store.list('flhas')) : null;
    if (existing) { nav(`safety/flha/${existing.id}`); return; }
    const prev = query.copy ? store.get('flhas', query.copy) : null;
    const draft = prev ? copyFlha(prev, day) : newFlha({ employeeId: person.id, jobId, date: day });
    return editor(root, ctx, draft, null);
  }
  const mine = rec.employeeId === person.id;
  if (isSigned(rec) || !mine) return reader(root, ctx, rec, { manager, mine });
  return editor(root, ctx, rec, rec.id);
}

function editor(root, ctx, draft, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const d = structuredClone(draft);
  // Make sure every built-in hazard has a row, in order, then any custom ones.
  const byId = new Map((d.hazards || []).map((x) => [x.id, x]));
  d.hazards = [...HAZARDS.map((hz) => byId.get(hz.id) || { id: hz.id, present: false, controls: '' }), ...(d.hazards || []).filter((x) => !HAZARDS.some((hz) => hz.id === x.id))];
  const ppe = new Set(d.ppe || []);

  const head = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: d.jobId || '', options: jobOptions(ctx), span: true },
    { label: 'Date', name: 'date', type: 'date', value: d.date, required: true },
    { label: 'Location on site', name: 'location', value: d.location, placeholder: 'e.g. Level 2 electrical room' },
    { label: 'Task', name: 'task', type: 'textarea', rows: 2, value: d.task, span: true, placeholder: 'What you are doing today' },
  ]);

  const hazardRows = h('div', { class: 'sf-hazards' }, d.hazards.map((hz) => {
    const def = HAZARDS.find((x) => x.id === hz.id);
    const controls = h('textarea', { class: 'input', rows: 2, 'aria-label': `Controls for ${hazardLabel(hz.id, hz.label)}`, placeholder: 'How you control it', onInput: (e) => { hz.controls = e.target.value; } }, hz.controls || '');
    const suggestions = def ? h('div', { class: 'sf-suggest' }, def.controls.map((c) => h('button', { type: 'button', class: 'sf-chip small', onClick: () => {
      hz.controls = (hz.controls ? hz.controls.replace(/\s*$/, '') + '\n' : '') + c; controls.value = hz.controls;
      for (const p of def.ppe) ppe.add(p);
      drawPpe();
    } }, '+ ' + c))) : null;
    const detail = h('div', { class: 'sf-hz-detail', hidden: !hz.present }, suggestions, controls);
    const row = h('div', { class: ['sf-hz', hz.present ? 'present' : null] },
      h('div', { class: 'sf-hz-head' }, h('span', { class: 'sf-hz-label' }, hazardLabel(hz.id, hz.label)),
        seg(ui, [['no', 'No'], ['yes', 'Yes']], hz.present ? 'yes' : 'no', (v) => { hz.present = v === 'yes'; detail.hidden = !hz.present; row.classList.toggle('present', hz.present); }, { label: hazardLabel(hz.id, hz.label) })),
      detail);
    return row;
  }));
  const addCustom = ui.button('Add another hazard', { size: 'sm', icon: 'plus', onClick: async () => {
    const label = await ui.promptDialog('Describe the hazard', { title: 'Other hazard' });
    if (!label?.trim()) return;
    const hz = { id: 'custom-' + Date.now().toString(36), label: label.trim(), present: true, controls: '' };
    d.hazards.push(hz);
    rerender();
  } });

  const ppeHost = h('div');
  const drawPpe = () => { ui.clear(ppeHost).append(chips(ui, PPE.map((p) => [p.id, p.label]), ppe, null, 'PPE')); };
  drawPpe();

  const stopReason = h('textarea', { class: 'input', rows: 2, 'aria-label': 'Why work is stopped', placeholder: 'What is unsafe and who you told', hidden: !d.stopWork, onInput: (e) => { d.stopWorkReason = e.target.value; } }, d.stopWorkReason || '');
  const stop = h('div', { class: ['sf-stop', d.stopWork ? 'on' : null] },
    h('div', { class: 'row' }, ui.icon(ICON_STOP, 20), h('strong', { class: 'grow' }, 'Stop work'),
      seg(ui, [['no', 'Safe to start'], ['yes', 'Stop work']], d.stopWork ? 'yes' : 'no', (v) => { d.stopWork = v === 'yes'; stopReason.hidden = !d.stopWork; stop.classList.toggle('on', d.stopWork); }, { label: 'Stop work' })),
    h('p', { class: 'muted sf-small' }, 'If a hazard can\'t be controlled, stop and tell your foreman. You have the right to refuse unsafe work.'),
    stopReason);

  const notes = h('textarea', { class: 'input', rows: 2, 'aria-label': 'Notes', onInput: (e) => { d.notes = e.target.value; } }, d.notes || '');
  const pad = signaturePad({ label: `Signature: ${person.name}` });
  const form = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, head);

  function collect() {
    const v = ui.readForm(form);
    return { ...d, jobId: v.jobId || null, date: v.date, task: v.task, location: v.location, ppe: [...ppe] };
  }
  function save(sign) {
    if (!form.reportValidity()) return;
    const data = collect();
    if (sign) {
      const open = uncontrolledHazards(data);
      if (open.length && !data.stopWork) { ui.toast(`Write how you control: ${open.map((x) => hazardLabel(x.id, x.label)).join(', ')}`, 'error', 4500); return; }
      if (data.stopWork && !String(data.stopWorkReason || '').trim()) { ui.toast('Say why work is stopped', 'error'); return; }
      const sig = signatureOf(pad, { name: person.name, employeeId: person.id });
      if (!sig) { ui.toast('Sign in the box first', 'error'); return; }
      data.signature = sig;
    }
    const saved = id ? store.update('flhas', id, data, { summary: `FLHA ${data.date}${sign ? ' signed' : ''}` }) : store.add('flhas', data);
    if (sign && data.stopWork) { notifySafety(ctx, 'stop-work', `${person.name} stopped work: ${data.stopWorkReason}`, saved.id); ui.toast('Stop work recorded. Tell your foreman now.', 'error', 5000); }
    else ui.toast(sign ? 'Hazard assessment signed' : 'Draft saved', 'success');
    nav(sign ? `safety/flha/${saved.id}` : 'safety');
  }

  function rerender() { ui.clear(root); editor(root, ctx, { ...collect(), hazards: d.hazards }, id); }

  root.append(ui.page({
    title: 'Field level hazard assessment',
    subtitle: d.copiedFrom ? 'Copied from your last FLHA: re-check every hazard, then sign.' : `${person.name} · ${ui.fmtDate(d.date)}`,
    actions: [backBtn(ui, '#/safety')],
  },
  h('div', { class: 'card stack' }, form),
  ...ui.section('Hazards', h('p', { class: 'muted sf-small' }, 'Tick each hazard that is present today and write how you control it.'), h('div', { class: 'card' }, hazardRows, h('div', { class: 'sf-pad-top' }, addCustom))),
  ...ui.section('PPE', h('div', { class: 'card' }, ppeHost)),
  h('div', { class: 'card sf-gap' }, stop),
  ...ui.section('Notes', notes),
  ...ui.section('Sign', h('div', { class: 'card stack' }, pad.el,
    h('div', { class: 'row sf-actions' }, ui.button('Save draft', { variant: 'ghost', onClick: () => save(false) }), h('span', { class: 'grow' }),
      ui.button('Sign and submit', { variant: 'primary', icon: 'check', onClick: () => save(true) }))))));
}

function reader(root, ctx, rec, { manager, mine }) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const job = rec.jobId && store.get('jobs', rec.jobId);
  const present = (rec.hazards || []).filter((x) => x.present);
  const reviewHost = h('div');
  const person = me(ctx);

  const drawReview = () => {
    ui.clear(reviewHost);
    if (rec.review?.at) {
      reviewHost.append(h('div', { class: 'card stack' }, h('div', { class: 'row' }, ui.badge('Reviewed', 'success'), h('span', null, `${rec.review.name || nameOf(store, rec.review.by)} · ${ui.fmtDateTime(rec.review.at)}`)),
        rec.review.note ? h('p', null, rec.review.note) : null, rec.review.signature ? signatureView(ui, rec.review.signature, 'Reviewed') : null));
      return;
    }
    if (!manager) { reviewHost.append(h('p', { class: 'muted' }, 'Waiting for the foreman\'s review.')); return; }
    const note = h('textarea', { class: 'input', rows: 2, 'aria-label': 'Review note', placeholder: 'Anything to add or change (optional)' });
    const pad = signaturePad({ label: `Foreman: ${person.name}` });
    reviewHost.append(h('div', { class: 'card stack' }, note, pad.el, h('div', { class: 'row' }, h('span', { class: 'grow' }),
      ui.button('Sign off review', { variant: 'primary', icon: 'check', onClick: () => {
        const review = { by: person.id, name: person.name, at: new Date().toISOString(), note: note.value.trim(), signature: signatureOf(pad, { name: person.name, employeeId: person.id }) };
        rec = store.update('flhas', rec.id, { review }, { summary: `FLHA reviewed by ${person.name}` });
        ui.toast('Review signed off', 'success');
        drawReview();
      } }))));
  };
  drawReview();

  root.append(ui.page({
    title: `FLHA · ${nameOf(store, rec.employeeId)}`,
    subtitle: `${ui.fmtDate(rec.date)}${job ? ' · ' + jobLabel(job) : ''}`,
    actions: [backBtn(ui, '#/safety'), ui.button('Print', { icon: 'printer', onClick: () => print() })],
  },
  rec.stopWork ? h('div', { class: 'sf-stop on card' }, h('div', { class: 'row' }, ui.icon(ICON_STOP, 20), h('strong', null, 'Work stopped')), h('p', null, rec.stopWorkReason || '')) : null,
  !isSigned(rec) ? h('div', { class: 'card' }, ui.badge('Draft', 'warning'), ' Not signed yet.') : null,
  h('div', { class: 'card stack' },
    rec.task ? h('div', null, h('strong', null, 'Task: '), rec.task) : null,
    rec.location ? h('div', null, h('strong', null, 'Location: '), rec.location) : null,
    rec.copiedFrom ? h('div', { class: 'muted' }, `Same as a previous day, re-checked ${ui.fmtDateTime(rec.recheckedAt)}`) : null),
  ...ui.section(`Hazards present (${present.length})`, present.length ? h('div', { class: 'list' }, present.map((x) => h('div', { class: 'list-row sf-hz-read' },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, hazardLabel(x.id, x.label)), h('div', { class: 'meta sf-pre' }, x.controls || '—'))))) : h('p', { class: 'muted' }, 'No hazards ticked.')),
  ...ui.section('PPE', h('div', { class: 'sf-chips' }, (rec.ppe || []).map((p) => h('span', { class: 'sf-chip', 'aria-pressed': 'true' }, ppeLabel(p))))),
  rec.notes ? ui.section('Notes', h('p', { class: 'sf-pre' }, rec.notes)) : null,
  ...ui.section('Worker signature', signatureView(ui, rec.signature)),
  ...ui.section('Foreman review', reviewHost),
  mine && !isSigned(rec) ? ui.button('Edit', { icon: 'edit', onClick: () => nav(`safety/flha/${rec.id}`) }) : null));
}
