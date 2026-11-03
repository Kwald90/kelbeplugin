// Site walkthroughs (#/walkthroughs): a guided, room-by-room photo record of a job site — the
// "CompanyCam walkthrough". Anyone on the job captures it on the phone, offline; it syncs like
// everything else. Internal by default; the office can mark one visible to the client (it reaches
// the client portal) and print or hand over a photo report.
//   #/walkthroughs              the list (filter by job)
//   #/walkthroughs/new?jobId=   start one (pick a job and a checkpoint template)
//   #/walkthroughs/:id          walk the site: photos, notes and done per stop; share; report
// Pure logic: js/lib/walkthroughs.js. Camera and downscaling: js/lib/safety-capture.js.
import { newWalkthrough, templatesFrom, templateById, newStop, progress, canShare, allStopsDone, walkthroughLabel, MAX_STOPS, MAX_PHOTOS_PER_STOP } from '../lib/walkthroughs.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/walkthroughs.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/walkthroughs.css';
  document.head.append(link);
}

export default {
  id: 'walkthroughs',
  title: 'Walkthroughs',
  icon: 'image',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { startNew(ctx); return; }
    if (sub) return detailView(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? `${j.number || ''}${j.number ? ' · ' : ''}${j.title || 'Job'}`.trim() : '—');
const clientName = (store, id) => (id ? store.get('clients', id)?.name || null : null);

// ---------- list ----------
function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let jobId = ctx.query.jobId || '';
  const host = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(host);
    const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
    const all = store.list('walkthroughs')
      .filter((w) => !jobId || w.jobId === jobId)
      .sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    const jobPick = h('select', { class: 'input wt-jobpick', 'aria-label': 'Job', onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', `#/walkthroughs${jobId ? `?jobId=${jobId}` : ''}`); draw(); } },
      h('option', { value: '' }, 'All jobs'),
      [...jobs.values()].sort((a, b) => String(b.number).localeCompare(String(a.number))).map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));
    h(host, null,
      h('div', { class: 'row wt-toolbar' }, jobPick, h('span', { class: 'grow' }),
        ui.button('New walkthrough', { variant: 'primary', icon: 'plus', href: `#/walkthroughs/new${jobId ? `?jobId=${jobId}` : ''}` })),
      all.length ? ui.table({
        columns: [
          { key: 'date', label: 'Date', render: (w) => ui.fmtDate(w.date || w.createdAt), sort: (w) => w.date || w.createdAt },
          { key: 'title', label: 'Walkthrough', render: (w) => w.title || 'Walkthrough' },
          { key: 'job', label: 'Job', render: (w) => jobLabel(jobs.get(w.jobId)) },
          { key: 'stops', label: 'Stops', align: 'right', render: (w) => { const p = progress(w); return `${p.done}/${p.total}`; } },
          { key: 'photos', label: 'Photos', align: 'right', render: (w) => progress(w).photos },
          { key: 'state', label: 'Status', render: (w) => (w.status === 'complete' ? ui.badge('complete', 'success') : ui.badge('in progress', 'warning')) },
          { key: 'shared', label: 'Client', render: (w) => (w.sharedWithClient ? ui.badge('shared', 'info') : '') },
        ],
        rows: all, onRowClick: (w) => nav(`walkthroughs/${w.id}`),
      }) : ui.empty({ icon: 'image', title: 'No walkthroughs yet', text: 'Walk a job site room by room, snapping photos as you go. Great for a before/after record, inspections and handing a visual report to the client.', action: ui.button('New walkthrough', { variant: 'primary', icon: 'plus', href: '#/walkthroughs/new' }) }));
  };

  root.append(ui.page({ title: 'Site walkthroughs', subtitle: 'Guided photo walkthroughs of the job site' }, host));
  draw();
  const off = store.on('walkthroughs', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  return off;
}

// ---------- start a new one ----------
function startNew(ctx) {
  const { store, ui, nav } = ctx;
  const jobs = store.list('jobs').filter((j) => (j.status || 'active') !== 'archived')
    .sort((a, b) => String(b.number).localeCompare(String(a.number)));
  if (!jobs.length) { ui.toast('Add a job first, then start a walkthrough for it.', 'info', 4000); nav('#/walkthroughs'); return; }
  const templates = templatesFrom(store.settings());
  const preJob = ctx.query.jobId && jobs.some((j) => j.id === ctx.query.jobId) ? ctx.query.jobId : jobs[0].id;

  ui.formSheet({
    title: 'New walkthrough',
    fields: [
      { label: 'Job', name: 'jobId', type: 'select', required: true, value: preJob, options: jobs.map((j) => ({ value: j.id, label: jobLabel(j) })) },
      { label: 'Checkpoints', name: 'templateId', type: 'select', value: templates[0]?.id || '', hint: 'A starting list of stops. You can add, rename or remove stops after.', options: templates.map((t) => ({ value: t.id, label: `${t.name}${t.stops?.length ? ` (${t.stops.length})` : ''}` })) },
      { label: 'Title', name: 'title', placeholder: 'Site walkthrough', span: true },
    ],
    submitLabel: 'Start',
    onSubmit: (v) => {
      const job = store.get('jobs', v.jobId);
      if (!job) { ui.toast('Pick a job', 'error'); return false; }
      const template = templateById(store.settings(), v.templateId);
      const w = newWalkthrough({ job, template, title: v.title, by: store.actorId, date: ui.today() });
      store.add('walkthroughs', w);
      nav(`#/walkthroughs/${w.id}`);
    },
    onClose: () => { if (location.hash.includes('/new')) nav('#/walkthroughs'); },
  });
}

// ---------- walk the site ----------
function detailView(root, ctx, id) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  let w = store.get('walkthroughs', id);
  if (!w) { ui.toast('That walkthrough is gone.', 'error'); nav('#/walkthroughs'); return; }
  const office = auth.can('invoices') || auth.isManager();

  // Persist a patch and keep the local copy in step (last writer wins; one person walks the site).
  const save = (patch) => { w = store.update('walkthroughs', id, patch); };
  const saveStops = () => save({ stops: w.stops });

  const job = store.get('jobs', w.jobId);
  const cName = clientName(store, w.clientId);

  const bar = h('div', { class: 'wt-bar' });
  const stopsHost = h('div', { class: 'wt-stops' });

  const drawBar = () => {
    const p = progress(w);
    ui.clear(bar).append(
      h('div', { class: 'wt-progress', role: 'progressbar', 'aria-valuenow': p.pct }, h('span', { style: { width: `${p.pct}%` } })),
      h('div', { class: 'wt-progress-meta muted' }, `${p.done} of ${p.total} stops · ${p.photos} photo${p.photos === 1 ? '' : 's'}`));
  };

  const shareRow = () => {
    const can = canShare(w) || w.sharedWithClient;
    const cb = h('input', { type: 'checkbox', checked: !!w.sharedWithClient, disabled: !office || (!w.clientId), onChange: (e) => {
      const on = e.target.checked;
      save(on ? { sharedWithClient: true, sharedAt: new Date().toISOString(), sharedBy: store.actorId } : { sharedWithClient: false });
      ui.toast(on ? 'This walkthrough is now visible to the client.' : 'No longer shared with the client.', on ? 'success' : 'info');
    } });
    const note = !w.clientId ? 'This job has no client, so there is nobody to share with.'
      : !office ? 'The office decides what the client sees.'
      : !can ? 'Add at least one photo, then you can share it.'
      : 'Shared walkthroughs appear in the client’s portal; you can also print or hand over the report.';
    return h('label', { class: 'wt-share check' }, cb, h('span', null, h('strong', null, 'Visible to client'), h('span', { class: 'hint' }, note)));
  };

  const drawStops = () => {
    ui.clear(stopsHost);
    (w.stops || []).forEach((stop, i) => stopsHost.append(stopCard(stop, i)));
    if ((w.stops || []).length < MAX_STOPS) {
      stopsHost.append(h('button', { type: 'button', class: 'wt-addstop', onClick: addStop }, ui.icon('plus', 16), 'Add a stop'));
    }
  };

  function stopCard(stop, i) {
    const done = !!stop.doneAt;
    const head = h('div', { class: 'wt-stop-head' },
      h('div', { class: 'wt-stop-n' }, String(i + 1)),
      h('div', { class: 'grow' }, h('div', { class: 'wt-stop-name' }, stop.name || `Stop ${i + 1}`),
        h('div', { class: 'wt-stop-sub muted' }, `${(stop.photos || []).length} photo${(stop.photos || []).length === 1 ? '' : 's'}`)),
      done ? ui.badge('done', 'success') : null,
      h('div', { class: 'wt-stop-tools' },
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'pen', title: 'Rename', onClick: () => renameStop(stop) }),
        ui.button(done ? 'Undo' : 'Done', { size: 'sm', variant: done ? 'ghost' : 'primary', onClick: () => { stop.doneAt = done ? null : new Date().toISOString(); saveStops(); drawStops(); drawBar(); } }),
        ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove stop', onClick: () => removeStop(stop) })));

    const photos = photoStrip({ photos: stop.photos, max: MAX_PHOTOS_PER_STOP, label: 'Add photo', toast: ui.toast, onChange: () => { saveStops(); drawBar(); } });
    const note = h('textarea', { class: 'input wt-note', rows: 2, placeholder: 'Note (optional)', value: stop.note || '' });
    let t = null;
    note.addEventListener('input', () => { stop.note = note.value.slice(0, 2000); clearTimeout(t); t = setTimeout(saveStops, 600); });
    note.addEventListener('blur', () => { clearTimeout(t); stop.note = note.value.slice(0, 2000); saveStops(); });

    return h('div', { class: ['wt-stop', done ? 'is-done' : null] }, head, photos, note);
  }

  function addStop() {
    ui.promptDialog('Name this stop (room or checkpoint)', { title: 'Add a stop', okLabel: 'Add' }).then((name) => {
      if (name == null) return;
      w.stops = [...(w.stops || []), newStop(name)];
      saveStops(); drawStops(); drawBar();
    });
  }
  function renameStop(stop) {
    ui.promptDialog('Stop name', { title: 'Rename stop', value: stop.name || '', okLabel: 'Save' }).then((name) => {
      if (name == null) return;
      stop.name = String(name).slice(0, 200); saveStops(); drawStops();
    });
  }
  async function removeStop(stop) {
    if ((stop.photos || []).length && !(await ui.confirmDialog('Remove this stop and its photos?', { okLabel: 'Remove' }))) return;
    w.stops = (w.stops || []).filter((s) => s.id !== stop.id);
    saveStops(); drawStops(); drawBar();
  }

  const complete = () => {
    if (w.status === 'complete') { save({ status: 'active', completedAt: null }); ui.toast('Reopened.', 'info'); }
    else {
      if (!allStopsDone(w) && !progress(w).photos) { ui.toast('Add some photos first.', 'error'); return; }
      save({ status: 'complete', completedAt: new Date().toISOString() });
      ui.toast('Walkthrough complete.', 'success');
    }
    rerenderHead();
  };

  // header actions
  const actionsHost = h('div', { class: 'row wt-head-actions' });
  const rerenderHead = () => {
    ui.clear(actionsHost).append(
      ui.button('Report', { icon: 'printer', variant: 'ghost', onClick: () => printReport(w, ctx) }),
      ui.button(w.status === 'complete' ? 'Reopen' : 'Mark complete', { variant: w.status === 'complete' ? 'ghost' : 'primary', onClick: complete }),
      office ? ui.button('', { variant: 'ghost danger', icon: 'x', title: 'Delete walkthrough', onClick: async () => {
        if (await ui.confirmDialog('Delete this walkthrough and its photos?', { okLabel: 'Delete' })) { store.remove('walkthroughs', id); nav('#/walkthroughs'); }
      } }) : null);
  };

  root.append(ui.page({
    title: walkthroughLabel(w),
    subtitle: [jobLabel(job), cName].filter(Boolean).join(' · ') || 'Walkthrough',
  },
    actionsHost, bar, shareRow(), stopsHost,
    h('div', { class: 'row wt-foot' }, ui.button('Back to walkthroughs', { variant: 'ghost', href: '#/walkthroughs' }))));

  rerenderHead();
  drawBar();
  drawStops();
}

// ---------- printable / shareable report ----------
function printReport(w, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const job = store.get('jobs', w.jobId);
  const company = store.settings().company || {};
  const cName = clientName(store, w.clientId);
  const p = progress(w);

  const node = h('div', { class: 'wt-print' },
    h('header', { class: 'wt-print-head' },
      h('div', null, h('h1', null, w.title || 'Site walkthrough'),
        h('div', { class: 'wt-print-sub' }, [jobLabel(job), cName, ui.fmtDate(w.date || w.createdAt)].filter(Boolean).join(' · '))),
      h('div', { class: 'wt-print-co' }, company.name || '', company.phone ? h('div', null, company.phone) : null)),
    h('div', { class: 'wt-print-meta' }, `${p.total} stops · ${p.photos} photo${p.photos === 1 ? '' : 's'}${w.status === 'complete' ? ' · complete' : ''}`),
    (w.stops || []).map((s, i) => h('section', { class: 'wt-print-stop' },
      h('h2', null, `${i + 1}. ${s.name || 'Stop'}`),
      s.note ? h('p', { class: 'wt-print-note' }, s.note) : null,
      (s.photos || []).length ? h('div', { class: 'wt-print-photos' }, (s.photos || []).map((ph) => h('figure', null, h('img', { src: ph.dataUrl, alt: ph.caption || s.name || '' }), ph.caption ? h('figcaption', null, ph.caption) : null))) : h('p', { class: 'muted' }, 'No photos.'))));

  document.body.append(node);
  document.body.classList.add('printing-walkthrough');
  const done = () => {
    node.remove();
    document.body.classList.remove('printing-walkthrough');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 50);
}
