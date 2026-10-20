// Toolbox talks: the topic library, scheduling, signed attendance, PDF and print record.
import { TOPICS, topicById } from '../../lib/safety-topics.js';
import { talkPdf } from '../../lib/safety-pdf.js';
import { signaturePad, signatureOf } from '../../lib/safety-capture.js';
import { me, jobOptions, jobLabel, nameOf, employeeOptions, backBtn, emptyNoEmployee } from './common.js';

export function talksList(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const manager = auth.isManager();
  const t = ui.today();
  const person = me(ctx);
  const all = store.list('toolboxTalks');
  const upcoming = all.filter((x) => x.status !== 'held' && x.status !== 'cancelled').sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const held = all.filter((x) => x.status === 'held').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const signed = (x) => (x.attendees || []).some((a) => a.employeeId && a.employeeId === person.id);
  const row = (x) => h('a', { class: 'list-row click', href: `#/safety/talks/${x.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, x.title || 'Toolbox talk'),
      h('div', { class: 'meta' }, [ui.fmtDate(x.date), x.time, jobLabel(store.get('jobs', x.jobId)), `${(x.attendees || []).length} signed`].filter(Boolean).join(' · '))),
    signed(x) ? ui.badge('You signed', 'success') : x.date === t && x.status !== 'held' ? ui.badge('Today', 'accent') : null,
    ui.statusBadge(x.status || 'scheduled'));
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }),
    manager ? ui.button('Schedule a talk', { variant: 'primary', icon: 'plus', onClick: () => scheduleTalk(ctx) }) : null));
  el.append(...ui.section('Upcoming', upcoming.length ? h('div', { class: 'list' }, upcoming.map(row)) : h('p', { class: 'muted' }, manager ? 'Nothing scheduled. Pick a topic from the library below.' : 'Nothing scheduled.')));
  if (held.length) el.append(...ui.section('Held', h('div', { class: 'list' }, held.slice(0, 50).map(row))));
  el.append(...ui.section('Topic library', h('div', { class: 'grid sf-topics' }, TOPICS.map((tp) => h('div', { class: 'card sf-topic' },
    h('h3', null, tp.title), h('p', { class: 'muted sf-small' }, tp.points[0]), h('div', { class: 'meta muted sf-small' }, tp.ref),
    manager ? ui.button('Schedule', { size: 'sm', icon: 'calendar', onClick: () => scheduleTalk(ctx, tp.id) }) : null)))));
}

export function scheduleTalk(ctx, topicId = '') {
  const { store, ui, nav } = ctx;
  const person = me(ctx);
  ui.formSheet({
    title: 'Schedule a toolbox talk',
    submitLabel: 'Schedule',
    fields: [
      { label: 'Topic', name: 'topicId', type: 'select', value: topicId, options: [{ value: '', label: 'Custom topic' }, ...TOPICS.map((tp) => ({ value: tp.id, label: tp.title }))], span: true },
      { label: 'Custom title', name: 'title', placeholder: 'Only for a custom topic', span: true },
      { label: 'Job', name: 'jobId', type: 'select', value: ctx.query?.jobId || '', options: jobOptions(ctx) },
      { label: 'Leader', name: 'leaderId', type: 'select', value: person.id || '', options: employeeOptions(ctx) },
      { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
      { label: 'Time', name: 'time', type: 'time', value: '07:00' },
      { label: 'Location', name: 'location', placeholder: 'e.g. Site trailer', span: true },
    ],
    onSubmit(v) {
      const tp = topicById(v.topicId);
      if (!tp && !v.title.trim()) { ui.toast('Pick a topic or write a title', 'error'); return false; }
      const rec = store.add('toolboxTalks', {
        topicId: tp?.id || null, title: tp ? tp.title : v.title.trim(), points: tp ? [...tp.points] : [], questions: tp ? [...tp.questions] : [],
        jobId: v.jobId || null, leaderId: v.leaderId || null, date: v.date, time: v.time, location: v.location, status: 'scheduled', attendees: [], notes: '', heldAt: null,
      });
      ui.toast('Talk scheduled', 'success');
      setTimeout(() => nav(`safety/talks/${rec.id}`), 0);
    },
  });
}

/** #/safety/talks/<id> */
export function talkView(root, ctx, id) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const manager = auth.isManager();
  const person = me(ctx);
  const host = h('div');
  root.append(host);
  const draw = () => {
    ui.clear(host);
    const talk = store.get('toolboxTalks', id);
    if (!talk) { host.append(ui.page({ title: 'Toolbox talk' }, ui.empty({ icon: 'book', title: 'Not found', action: ui.button('Safety', { href: '#/safety?tab=talks' }) }))); return; }
    const job = talk.jobId && store.get('jobs', talk.jobId);
    const iSigned = (talk.attendees || []).some((a) => a.employeeId && a.employeeId === person.id);
    const company = store.settings().company || {};
    const pdf = () => {
      const bytes = talkPdf(talk, { company, jobLabel: jobLabel(job), leaderName: nameOf(store, talk.leaderId, ''), nameOf: (eid) => nameOf(store, eid, '') });
      ui.download(`toolbox-talk-${talk.date || 'record'}.pdf`, new Blob([bytes], { type: 'application/pdf' }), 'application/pdf');
      store.log('export', `Toolbox talk PDF: ${talk.title}`, 'toolboxTalks', talk.id);
    };
    const notes = h('textarea', { class: 'input', rows: 3, 'aria-label': 'Notes and crew concerns', disabled: !manager }, talk.notes || '');
    host.append(ui.page({
      title: talk.title || 'Toolbox talk',
      subtitle: [ui.fmtDate(talk.date), talk.time, jobLabel(job), talk.location, talk.leaderId ? `led by ${nameOf(store, talk.leaderId)}` : null].filter(Boolean).join(' · '),
      actions: [backBtn(ui, '#/safety?tab=talks'), ui.button('PDF', { icon: 'download', onClick: pdf }), ui.button('Print', { icon: 'printer', onClick: () => print() })],
    },
    h('div', { class: 'row sf-gap' }, ui.statusBadge(talk.status || 'scheduled'), h('span', { class: 'muted' }, `${(talk.attendees || []).length} signed`), h('span', { class: 'grow' }),
      manager && talk.status !== 'held' ? ui.button('Mark held', { icon: 'check', onClick: () => { store.update('toolboxTalks', id, { status: 'held', heldAt: new Date().toISOString() }); ui.toast('Talk marked held', 'success'); } }) : null,
      manager && talk.status === 'held' ? ui.button('Reopen', { variant: 'ghost', onClick: () => store.update('toolboxTalks', id, { status: 'scheduled', heldAt: null }) }) : null),
    (talk.points || []).length ? ui.section('Key points', h('ol', { class: 'sf-points' }, talk.points.map((p) => h('li', null, p)))) : null,
    (talk.questions || []).length ? ui.section('Ask the crew', h('ul', { class: 'sf-points' }, talk.questions.map((q) => h('li', null, q)))) : null,
    ...ui.section('Notes and crew concerns', notes, manager ? h('div', { class: 'row no-print sf-pad-top' }, ui.button('Save notes', { size: 'sm', onClick: () => { store.update('toolboxTalks', id, { notes: notes.value }); ui.toast('Saved', 'success'); } })) : null),
    ...ui.section(`Attendance (${(talk.attendees || []).length})`,
      h('div', { class: 'row no-print sf-gap' },
        person.id && !iSigned ? ui.button('Sign attendance', { variant: 'primary', icon: 'pen', onClick: () => signSheet(ctx, talk, { self: true }) }) : null,
        iSigned ? ui.badge('You signed', 'success') : null,
        !person.id && !manager ? emptyNoEmployee(ui) : null,
        manager ? ui.button('Add attendee', { icon: 'plus', onClick: () => signSheet(ctx, talk, { self: false }) }) : null),
      (talk.attendees || []).length ? h('div', { class: 'sf-attendees' }, talk.attendees.map((a) => h('div', { class: 'sf-attendee' },
        h('div', null, h('strong', null, a.name || nameOf(store, a.employeeId)), a.company ? h('div', { class: 'muted sf-small' }, a.company) : null, h('div', { class: 'muted sf-small' }, ui.fmtDateTime(a.at))),
        a.signature?.dataUrl ? h('img', { class: 'sf-sig-img', src: a.signature.dataUrl, alt: `Signature of ${a.name || ''}` }) : h('span', { class: 'muted' }, 'no signature'))))
        : h('p', { class: 'muted' }, 'Nobody has signed yet.'))));
  };
  draw();
  return store.on('toolboxTalks', (e) => { if (e.record?.id === id) draw(); });
}

/** Sign for yourself, or (managers, on a shared iPad) for a crew member or visitor. */
function signSheet(ctx, talk, { self }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const who = self ? null : h('select', { class: 'input', 'aria-label': 'Who is signing' }, employeeOptions(ctx, 'Visitor or subcontractor').map((o) => h('option', { value: o.value }, o.label)));
  const visitor = self ? null : h('input', { class: 'input', placeholder: 'Name (visitor or subcontractor)', 'aria-label': 'Visitor name' });
  const company = self ? null : h('input', { class: 'input', placeholder: 'Company (optional)', 'aria-label': 'Company' });
  const pad = signaturePad({ label: self ? `Signature: ${person.name}` : 'Signature' });
  const s = ui.openSheet({
    title: self ? `Sign: ${talk.title}` : 'Add attendee',
    body: h('div', { class: 'stack' },
      self ? h('p', { class: 'muted' }, `I attended this talk and understood it. ${person.name}`) : h('div', { class: 'stack' }, who, visitor, company),
      pad.el),
    actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Sign', { variant: 'primary', icon: 'check', onClick: () => {
      const employeeId = self ? person.id : who.value || null;
      const name = self ? person.name : employeeId ? nameOf(store, employeeId) : visitor.value.trim();
      if (!name) { ui.toast('Pick a person or type a name', 'error'); return; }
      const sig = signatureOf(pad, { name, employeeId });
      if (!sig) { ui.toast('Sign in the box first', 'error'); return; }
      const cur = store.get('toolboxTalks', talk.id);
      if (employeeId && (cur.attendees || []).some((a) => a.employeeId === employeeId)) { ui.toast(`${name} already signed`, 'info'); s.close(); return; }
      store.update('toolboxTalks', talk.id, { attendees: [...(cur.attendees || []), { employeeId, name, company: company?.value.trim() || '', signature: sig, at: sig.at }] }, { summary: `${name} signed ${cur.title}` });
      ui.toast(`${name} signed`, 'success');
      s.close();
    } })],
  });
}
