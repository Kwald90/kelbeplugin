// RFI log (#/rfis): Requests for Information raised to the GC or engineer on a job. Each RFI carries an
// auto number per job, a subject and question, a discipline, who it is to, dates raised and needed-by,
// a status (open → answered → closed), the answer with its date, cost/schedule impact flags and
// attachments. The list is filtered by job + status; a single RFI prints. Pure logic: js/lib/rfis.js.
//   #/rfis               the list (filtered by job + status)
//   #/rfis?jobId=:id     the list for one job
import { newRfi, answerPatch, closePatch, reopenPatch, isOpen, isAnswered, isClosed, isOverdue, filterRfis, sortRfis, summarize, statusLabel, rfiNo, rfiLabel, DISCIPLINES, STATUSES } from '../lib/rfis.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/rfis.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/rfis.css';
  document.head.append(link);
}

export default {
  id: 'rfis',
  title: 'RFIs',
  icon: 'send',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const statusTone = { open: 'info', answered: 'success', closed: 'neutral' };

function listView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  let jobId = query.jobId || '';
  let status = 'open';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input rfi-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/rfis' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  function draw() {
    ui.clear(host);
    const today = ui.today();
    const all = store.list('rfis');
    const forJob = filterRfis(all, { jobId });
    const shown = sortRfis(filterRfis(forJob, { status: status === 'all' ? '' : status }));
    const sum = summarize(forJob, today);

    h(host, null,
      h('div', { class: 'grid rfi-stats' },
        ui.stat({ label: 'Open', value: String(sum.open), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'Answered', value: String(sum.answered), tone: sum.answered ? 'success' : 'neutral' }),
        ui.stat({ label: 'Overdue', value: String(sum.overdue), tone: sum.overdue ? 'warning' : 'neutral' }),
        ui.stat({ label: 'Closed', value: String(sum.closed), hint: 'Filed' })),
      h('div', { class: 'row rfi-toolbar' },
        jobSelect,
        ui.button('Print register', { icon: 'printer', onClick: () => printRegister(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('New RFI', { variant: 'primary', icon: 'plus', onClick: () => editRfi(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      h('div', { class: 'row rfi-tabs' },
        ui.tabs(
          [{ id: 'open', label: `Open (${sum.open})` }, { id: 'answered', label: `Answered (${sum.answered})` }, { id: 'closed', label: `Closed (${sum.closed})` }, { id: 'all', label: `All (${sum.total})` }],
          status, (v) => { status = v; draw(); })),
      tableHost);

    drawTable(shown, today);

    function drawTable(rows, asOf) {
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'No.', render: (r) => rfiNo(r), sort: (r) => Number(r.number) || 0 },
          { key: 'subject', label: 'Subject', render: (r) => h('div', null, h('div', { class: 'rfi-subj' }, r.subject || '(no subject)'), r.discipline ? h('div', { class: 'muted rfi-sub' }, r.discipline) : null), sort: (r) => (r.subject || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (r) => jobLabel(jobById.get(r.jobId)), sort: (r) => jobById.get(r.jobId)?.number || '' },
          { key: 'to', label: 'To', render: (r) => r.toName || '—' },
          { key: 'needed', label: 'Needed by', render: (r) => (r.neededBy ? h('span', { class: isOverdue(r, asOf) ? 'rfi-overdue' : null }, ui.fmtDate(r.neededBy)) : '—'), sort: (r) => r.neededBy || '9999' },
          { key: 'status', label: 'Status', render: (r) => ui.badge(statusLabel(r.status), statusTone[r.status || 'open'] || 'neutral'), sort: (r) => r.status || 'open' },
        ],
        rows,
        onRowClick: (r) => editRfi(ctx, r.id, { onDraw: draw }),
        empty: ui.empty({
          icon: 'send',
          title: all.length ? 'Nothing here' : 'No RFIs yet',
          text: all.length ? 'No RFIs match this job and status.' : 'Raise a Request for Information to the GC or engineer when the drawings are unclear — the question, who it is to and when you need it by — then log the answer and print the register.',
          action: ui.button('New RFI', { variant: 'primary', icon: 'plus', onClick: () => editRfi(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'RFIs',
    subtitle: 'Requests for Information to the GC or engineer, with the answer and a printable register.',
    actions: [ui.button('New RFI', { variant: 'primary', icon: 'plus', onClick: () => editRfi(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('rfis', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function editRfi(ctx, id, { jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const all = store.list('rfis');
  const r = id ? store.get('rfis', id) : newRfi({ job: jobId ? store.get('jobs', jobId) : null, items: all, by: store.actorId, date: ui.today() });
  if (!r) { ui.toast('That RFI is gone.', 'error'); return; }
  r.photos = r.photos || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const discList = h('datalist', { id: 'rfi-disc' }, DISCIPLINES.map((d) => h('option', { value: d })));

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: r.jobId || '', options: [{ value: '', label: '— none —' }, ...ui.recordOptions(jobs, (j) => jobLabel(j), '— none —').slice(1)] },
    { label: 'Discipline', name: 'discipline', value: r.discipline, placeholder: 'Electrical' },
    { label: 'Subject', name: 'subject', value: r.subject, span: true, placeholder: 'Short title, e.g. Panel A location clash' },
    { label: 'Question', name: 'question', type: 'textarea', value: r.question, span: true, placeholder: 'What you need clarified, with the drawing / spec reference' },
    { label: 'To (GC / engineer)', name: 'toName', value: r.toName, placeholder: 'Who the RFI goes to' },
    { label: 'Date raised', name: 'dateRaised', type: 'date', value: r.dateRaised },
    { label: 'Needed by', name: 'neededBy', type: 'date', value: r.neededBy },
    { label: 'Status', name: 'status', type: 'select', value: r.status || 'open', options: STATUSES.map((s) => ({ value: s.id, label: s.label })) },
    { label: 'Answer', name: 'answer', type: 'textarea', value: r.answer, span: true, placeholder: 'The response from the GC or engineer' },
    { label: 'Answered date', name: 'answeredDate', type: 'date', value: r.answeredDate },
    { label: 'Notes', name: 'notes', type: 'textarea', value: r.notes, span: true },
  ]);
  grid.querySelector('[name="discipline"]')?.setAttribute('list', 'rfi-disc');

  const costImpact = h('input', { type: 'checkbox', checked: !!r.costImpact });
  const schedImpact = h('input', { type: 'checkbox', checked: !!r.scheduleImpact });
  const impacts = h('div', { class: 'rfi-impacts' },
    h('label', { class: 'field check' }, costImpact, h('span', null, 'Cost impact')),
    h('label', { class: 'field check' }, schedImpact, h('span', null, 'Schedule impact')));

  const photos = h('div', null,
    h('h3', { class: 'rfi-h3' }, 'Attachments'),
    photoStrip({ photos: r.photos, max: 8, label: 'Add photo', toast: ui.toast }));

  const collect = () => {
    const v = ui.readForm(body);
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || r.clientId || null,
      subject: v.subject || '', discipline: v.discipline || '', question: v.question || '',
      status: v.status || 'open', dateRaised: v.dateRaised || null, neededBy: v.neededBy || null,
      toName: v.toName || '', answer: v.answer || '', answeredDate: v.answeredDate || null,
      costImpact: costImpact.checked, scheduleImpact: schedImpact.checked,
      notes: v.notes || '', photos: r.photos,
    };
  };
  const persist = (extra = {}) => {
    const patch = { ...collect(), ...extra };
    if (id) return store.update('rfis', id, patch);
    const rec = store.add('rfis', { ...r, ...patch });
    id = rec.id;
    return rec;
  };

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, grid, impacts, discList, photos);

  // Answer / Close / Reopen: the quick status action for where the RFI is now.
  const actionBtn = isClosed(r)
    ? ui.button('Reopen', { variant: 'ghost', icon: 'undo', onClick: () => { const p = reopenPatch(); Object.assign(r, p); persist(p); ui.toast('Reopened', 'success'); sheet.close(); onDraw?.(); } })
    : isAnswered(r)
      ? ui.button('Close out', { variant: 'primary', icon: 'check', onClick: () => { const p = closePatch(); Object.assign(r, p); persist(p); ui.toast('RFI closed', 'success'); sheet.close(); onDraw?.(); } })
      : ui.button('Mark answered', { variant: 'primary', icon: 'check', onClick: () => { const p = answerPatch(r, { by: store.actorId }); Object.assign(r, p); persist(p); ui.toast('Marked answered', 'success'); sheet.close(); onDraw?.(); } });

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this RFI?', { okLabel: 'Delete' }))) return;
    store.remove('rfis', id); ui.toast('RFI deleted'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? rfiLabel(r) : 'New RFI',
    body,
    actions: [
      id ? ui.button('Print', { variant: 'ghost', icon: 'printer', onClick: () => { persist(); printOne(ctx, store.get('rfis', id)); } }) : null,
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      h('span', { class: 'grow' }),
      actionBtn,
      ui.button('Save', { variant: 'primary', icon: 'check', onClick: () => {
        if (!body.reportValidity()) return;
        persist();
        ui.toast('Saved', 'success');
        sheet.close();
        onDraw?.();
      } }),
    ].filter(Boolean),
  });
}

// ---------- print ----------
function rfiDocHead(ui, co, kind) {
  const { h } = ui;
  return h('header', { class: 'rfi-doc-top' },
    h('div', null, h('div', { class: 'rfi-doc-brand' }, co.name || 'Company'), h('div', { class: 'rfi-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
    h('div', { class: 'rfi-doc-right' }, h('div', { class: 'rfi-doc-kind' }, kind), h('div', null, ui.fmtDate(new Date()))));
}
function runPrint(node, cls) {
  document.body.append(node);
  document.body.classList.add(cls);
  const done = () => { node.remove(); document.body.classList.remove(cls); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}

/** One RFI as a printable form. */
function printOne(ctx, r) {
  const { store, ui } = ctx;
  const { h } = ui;
  if (!r) return;
  const co = store.settings().company || {};
  const job = r.jobId ? store.get('jobs', r.jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const row = (label, value) => h('tr', null, h('th', null, label), h('td', null, value || '—'));
  const node = h('div', { class: 'rfi-print' }, h('article', { class: 'rfi-doc' },
    rfiDocHead(ui, co, 'RFI'),
    h('h1', null, `${rfiNo(r)}${r.subject ? ` — ${r.subject}` : ''}`),
    h('table', { class: 'rfi-meta' }, h('tbody', null,
      row('Job', job ? jobLabel(job) : '—'),
      row('Client', client?.name),
      row('Discipline', r.discipline),
      row('To', r.toName),
      row('Date raised', r.dateRaised ? ui.fmtDate(r.dateRaised) : '—'),
      row('Needed by', r.neededBy ? ui.fmtDate(r.neededBy) : '—'),
      row('Status', statusLabel(r.status)),
      row('Impact', [r.costImpact ? 'Cost' : null, r.scheduleImpact ? 'Schedule' : null].filter(Boolean).join(', ') || 'None noted'))),
    h('h2', null, 'Question'),
    h('p', { class: 'rfi-doc-body' }, r.question || '—'),
    h('h2', null, 'Answer'),
    h('p', { class: 'rfi-doc-body' }, r.answer || '(awaiting response)'),
    r.answeredDate ? h('p', { class: 'rfi-doc-small' }, `Answered ${ui.fmtDate(r.answeredDate)}`) : null,
    r.photos?.length ? [h('h2', null, 'Attachments'), h('div', { class: 'rfi-doc-photos' }, r.photos.map((p) => h('figure', null, h('img', { src: p.dataUrl, alt: '' }), p.caption ? h('figcaption', null, p.caption) : null)))] : null));
  runPrint(node, 'rfi-printing');
}

/** The RFI register: every RFI for the chosen job (or all), lowest number first. */
function printRegister(ctx, { jobId, jobById }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const all = filterRfis(store.list('rfis'), { jobId }).sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const sum = summarize(all);

  const node = h('div', { class: 'rfi-print' }, h('article', { class: 'rfi-doc' },
    rfiDocHead(ui, co, 'RFI register'),
    h('h1', null, 'RFI register'),
    h('p', { class: 'rfi-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${sum.open} open of ${sum.total}`].filter(Boolean).join(' · ')),
    all.length ? h('table', null,
      h('thead', null, h('tr', null, ['No.', 'Subject', 'Discipline', 'To', 'Raised', 'Needed', 'Status'].map((x) => h('th', null, x)))),
      h('tbody', null, all.map((r) => h('tr', null,
        h('td', null, rfiNo(r)),
        h('td', null, r.subject || '—'),
        h('td', null, r.discipline || '—'),
        h('td', null, r.toName || '—'),
        h('td', null, r.dateRaised ? ui.fmtDate(r.dateRaised) : '—'),
        h('td', null, r.neededBy ? ui.fmtDate(r.neededBy) : '—'),
        h('td', null, statusLabel(r.status)))))) : h('p', null, 'No RFIs logged.')));
  runPrint(node, 'rfi-printing');
}
