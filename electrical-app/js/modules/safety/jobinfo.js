// Emergency information per job (managers edit; everyone sees it on the job and in Safety).
import { jobSafetyId } from '../../lib/safety.js';
import { emergencyCard } from '../../lib/safety-emergency.js';
import { jobLabel, backBtn } from './common.js';

/** #/safety/job/<jobId> */
export function jobInfoView(root, ctx, jobId) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const job = store.get('jobs', jobId);
  if (!job) { root.append(ui.page({ title: 'Emergency info' }, ui.empty({ icon: 'briefcase', title: 'Job not found' }))); return; }
  const id = jobSafetyId(jobId);
  const cur = store.get('jobSafety', id) || { jobId, hospital: {}, emergencyContacts: [], firstAiders: [], siteHazards: [] };
  if (!auth.isManager()) {
    root.append(ui.page({ title: `Emergency · ${jobLabel(job)}`, actions: [backBtn(ui, `#/jobs/${jobId}`)] },
      emergencyCard(ctx, jobId) || ui.empty({ icon: 'info', title: 'No emergency information yet', text: 'Ask your foreman to add it.' })));
    return;
  }
  const firstAiders = new Set(cur.firstAiders || []);
  const contacts = structuredClone(cur.emergencyContacts || []);
  const form = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, ui.formGrid([
    { label: 'Nearest hospital', name: 'hName', value: cur.hospital?.name, placeholder: 'e.g. General Hospital emergency' },
    { label: 'Hospital phone', name: 'hPhone', type: 'tel', value: cur.hospital?.phone },
    { label: 'Hospital address', name: 'hAddress', value: cur.hospital?.address, span: true },
    { label: 'Muster point', name: 'musterPoint', value: cur.musterPoint, span: true, placeholder: 'e.g. North gate by the site trailer' },
    { label: 'First-aid kit', name: 'firstAidKit', value: cur.firstAidKit, placeholder: 'Where it is' },
    { label: 'AED', name: 'aed', value: cur.aed },
    { label: 'Fire extinguisher', name: 'extinguisher', value: cur.extinguisher },
    { label: 'Require an FLHA before work each day', name: 'flhaRequired', type: 'checkbox', value: cur.flhaRequired !== false },
    { label: 'Site hazards (one per line)', name: 'siteHazards', type: 'textarea', rows: 3, value: (cur.siteHazards || []).join('\n'), span: true },
  ]));
  const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const aiders = h('div', { class: 'sf-chips' }, people.map((p) => {
    const b = h('button', { type: 'button', class: 'sf-chip', 'aria-pressed': String(firstAiders.has(p.id)), onClick: () => { if (firstAiders.has(p.id)) firstAiders.delete(p.id); else firstAiders.add(p.id); b.setAttribute('aria-pressed', String(firstAiders.has(p.id))); } }, p.name);
    return b;
  }));
  const contactHost = h('div', { class: 'stack' });
  const drawContacts = () => {
    ui.clear(contactHost);
    contacts.forEach((c, i) => contactHost.append(h('div', { class: 'sf-witness' },
      h('input', { class: 'input', placeholder: 'Name', 'aria-label': `Contact ${i + 1} name`, value: c.name || '', onInput: (e) => { c.name = e.target.value; } }),
      h('input', { class: 'input', placeholder: 'Role (GC super, owner...)', 'aria-label': `Contact ${i + 1} role`, value: c.role || '', onInput: (e) => { c.role = e.target.value; } }),
      h('input', { class: 'input', type: 'tel', placeholder: 'Phone', 'aria-label': `Contact ${i + 1} phone`, value: c.phone || '', onInput: (e) => { c.phone = e.target.value; } }))));
    contactHost.append(ui.button('Add contact', { size: 'sm', icon: 'plus', onClick: () => { contacts.push({ name: '', role: '', phone: '' }); drawContacts(); } }));
  };
  drawContacts();
  const save = () => {
    const v = ui.readForm(form);
    const data = {
      jobId, hospital: { name: v.hName, phone: v.hPhone, address: v.hAddress }, musterPoint: v.musterPoint, firstAidKit: v.firstAidKit, aed: v.aed,
      extinguisher: v.extinguisher, flhaRequired: v.flhaRequired, siteHazards: String(v.siteHazards || '').split('\n').map((s) => s.trim()).filter(Boolean),
      firstAiders: [...firstAiders], emergencyContacts: contacts.filter((c) => c.name || c.phone),
    };
    if (store.get('jobSafety', id)) store.update('jobSafety', id, data, { summary: `Emergency info ${job.number || ''}` });
    else store.add('jobSafety', { ...data, id });
    ui.toast('Emergency info saved', 'success');
    nav(`jobs/${jobId}`);
  };
  root.append(ui.page({ title: `Emergency info · ${jobLabel(job)}`, actions: [backBtn(ui, `#/jobs/${jobId}`), ui.button('Save', { variant: 'primary', icon: 'save', onClick: save })] },
    h('div', { class: 'card' }, form),
    ...ui.section('First aiders', h('div', { class: 'card' }, aiders)),
    ...ui.section('Emergency contacts', h('div', { class: 'card' }, contactHost))));
}
