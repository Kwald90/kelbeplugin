// Submittal log (#/submittals): the shop drawings, product data and samples a contractor submits to
// the GC or engineer for review on a job. Each submittal has an auto number per job, a spec section and
// description, a type, a status through the review cycle, submitted and returned dates, the reviewer and
// a revision number. The list is filtered by job + status; the register prints. Pure logic: js/lib/submittals.js.
//   #/submittals             the list (filtered by job + status)
//   #/submittals?jobId=:id   the list for one job
import { newSubmittal, submitPatch, reviewPatch, revisePatch, isDraft, isOutstanding, isClosed, filterSubmittals, sortSubmittals, summarize, typeLabel, statusLabel, submittalNo, submittalLabel, TYPES, STATUSES, REVIEW_OUTCOMES } from '../lib/submittals.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/submittals.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/submittals.css';
  document.head.append(link);
}

export default {
  id: 'submittals',
  title: 'Submittals',
  icon: 'file-text',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const statusTone = {
  draft: 'neutral', submitted: 'info', 'under-review': 'warning',
  approved: 'success', 'approved-as-noted': 'success', 'revise-resubmit': 'warning', rejected: 'danger',
};

function listView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  let jobId = query.jobId || '';
  let status = 'outstanding';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input sub-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/submittals' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  // The tabs map to the status groups in the lib; 'outstanding' spans submitted + under-review.
  const inGroup = (s, group) => {
    if (group === 'all') return true;
    if (group === 'draft') return isDraft(s);
    if (group === 'outstanding') return isOutstanding(s);
    if (group === 'closed') return isClosed(s);
    return true;
  };

  function draw() {
    ui.clear(host);
    const all = store.list('submittals');
    const forJob = filterSubmittals(all, { jobId });
    const shown = sortSubmittals(forJob.filter((s) => inGroup(s, status)));
    const sum = summarize(forJob);

    h(host, null,
      h('div', { class: 'grid sub-stats' },
        ui.stat({ label: 'Out for review', value: String(sum.outstanding), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs', tone: sum.outstanding ? 'info' : 'neutral' }),
        ui.stat({ label: 'Drafts', value: String(sum.draft), hint: 'Not sent yet' }),
        ui.stat({ label: 'Closed', value: String(sum.closed), hint: 'Approved or rejected' }),
        ui.stat({ label: 'Total', value: String(sum.total) })),
      h('div', { class: 'row sub-toolbar' },
        jobSelect,
        ui.button('Print register', { icon: 'printer', onClick: () => printRegister(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('New submittal', { variant: 'primary', icon: 'plus', onClick: () => editSubmittal(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      h('div', { class: 'row sub-tabs' },
        ui.tabs(
          [{ id: 'outstanding', label: `Out for review (${sum.outstanding})` }, { id: 'draft', label: `Drafts (${sum.draft})` }, { id: 'closed', label: `Closed (${sum.closed})` }, { id: 'all', label: `All (${sum.total})` }],
          status, (v) => { status = v; draw(); })),
      tableHost);

    drawTable(shown);

    function drawTable(rows) {
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'No.', render: (s) => submittalNo(s), sort: (s) => Number(s.number) || 0 },
          { key: 'desc', label: 'Description', render: (s) => h('div', null, h('div', { class: 'sub-desc' }, s.description || '(no description)'), s.specSection ? h('div', { class: 'muted sub-sub' }, `Spec ${s.specSection}`) : null), sort: (s) => (s.description || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (s) => jobLabel(jobById.get(s.jobId)), sort: (s) => jobById.get(s.jobId)?.number || '' },
          { key: 'type', label: 'Type', render: (s) => typeLabel(s.type) },
          { key: 'submitted', label: 'Submitted', render: (s) => (s.submittedDate ? ui.fmtDate(s.submittedDate) : '—'), sort: (s) => s.submittedDate || '' },
          { key: 'status', label: 'Status', render: (s) => ui.badge(statusLabel(s.status), statusTone[s.status || 'draft'] || 'neutral'), sort: (s) => s.status || 'draft' },
        ],
        rows,
        onRowClick: (s) => editSubmittal(ctx, s.id, { onDraw: draw }),
        empty: ui.empty({
          icon: 'file-text',
          title: all.length ? 'Nothing here' : 'No submittals yet',
          text: all.length ? 'No submittals match this job and status.' : 'Log the shop drawings, product data and samples you send to the GC or engineer for review — the spec section, the type and the review status — then track approvals and print the register.',
          action: ui.button('New submittal', { variant: 'primary', icon: 'plus', onClick: () => editSubmittal(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'Submittals',
    subtitle: 'Shop drawings, product data and samples sent for review, with a printable register.',
    actions: [ui.button('New submittal', { variant: 'primary', icon: 'plus', onClick: () => editSubmittal(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('submittals', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function editSubmittal(ctx, id, { jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const all = store.list('submittals');
  const s = id ? store.get('submittals', id) : newSubmittal({ job: jobId ? store.get('jobs', jobId) : null, items: all, by: store.actorId });
  if (!s) { ui.toast('That submittal is gone.', 'error'); return; }
  s.photos = s.photos || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: s.jobId || '', options: [{ value: '', label: '— none —' }, ...ui.recordOptions(jobs, (j) => jobLabel(j), '— none —').slice(1)] },
    { label: 'Spec section', name: 'specSection', value: s.specSection, placeholder: 'e.g. 26 24 16' },
    { label: 'Type', name: 'type', type: 'select', value: s.type || 'shop-drawing', options: TYPES.map((t) => ({ value: t.id, label: t.label })) },
    { label: 'Status', name: 'status', type: 'select', value: s.status || 'draft', options: STATUSES.map((st) => ({ value: st.id, label: st.label })) },
    { label: 'Description', name: 'description', type: 'textarea', value: s.description, span: true, placeholder: 'What is being submitted, e.g. Panelboards and distribution' },
    { label: 'Submitted date', name: 'submittedDate', type: 'date', value: s.submittedDate },
    { label: 'Returned date', name: 'returnedDate', type: 'date', value: s.returnedDate },
    { label: 'Reviewer', name: 'reviewer', value: s.reviewer, placeholder: 'GC / engineer reviewer' },
    { label: 'Revision', name: 'revision', type: 'number', value: s.revision ?? 0, min: 0 },
    { label: 'Notes', name: 'notes', type: 'textarea', value: s.notes, span: true },
  ]);

  const photos = h('div', null,
    h('h3', { class: 'sub-h3' }, 'Attachments'),
    photoStrip({ photos: s.photos, max: 8, label: 'Add attachment', toast: ui.toast }));

  const collect = () => {
    const v = ui.readForm(body);
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || s.clientId || null,
      specSection: v.specSection || '', description: v.description || '',
      type: v.type || 'shop-drawing', status: v.status || 'draft',
      submittedDate: v.submittedDate || null, returnedDate: v.returnedDate || null,
      reviewer: v.reviewer || '', revision: Math.max(0, Number(v.revision) || 0),
      notes: v.notes || '', photos: s.photos,
    };
  };
  const persist = (extra = {}) => {
    const patch = { ...collect(), ...extra };
    if (id) return store.update('submittals', id, patch);
    const rec = store.add('submittals', { ...s, ...patch });
    id = rec.id;
    return rec;
  };

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, grid, photos);

  // The quick status action for where the submittal is now: send a draft, record the review outcome,
  // or start a new revision after a revise-and-resubmit.
  const apply = (patch, msg) => { Object.assign(s, patch); persist(patch); ui.toast(msg, 'success'); sheet.close(); onDraw?.(); };
  let primaryAction;
  if (isDraft(s)) {
    primaryAction = ui.button('Submit', { variant: 'primary', icon: 'send', onClick: () => apply(submitPatch(s), 'Marked submitted') });
  } else if (isOutstanding(s)) {
    primaryAction = ui.button('Record review…', { variant: 'primary', icon: 'check', onClick: () => {
      const r = ui.openSheet({
        title: 'Record reviewer return', dialog: true,
        body: h('div', { class: 'list' }, REVIEW_OUTCOMES.map((o) => h('button', { type: 'button', class: 'list-row click', onClick: () => { r.close(); apply(reviewPatch(s, o.id), `Marked ${o.label.toLowerCase()}`); } }, o.label))),
        actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => r.close() })],
      });
    } });
  } else if (s.status === 'revise-resubmit') {
    primaryAction = ui.button('Start revision', { variant: 'primary', icon: 'undo', onClick: () => apply(revisePatch(s), `Revision ${(Number(s.revision) || 0) + 1} started`) });
  } else {
    primaryAction = null; // approved / approved-as-noted / rejected: no quick next step
  }

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this submittal?', { okLabel: 'Delete' }))) return;
    store.remove('submittals', id); ui.toast('Submittal deleted'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? submittalLabel(s) : 'New submittal',
    body,
    actions: [
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      h('span', { class: 'grow' }),
      primaryAction,
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
/** The submittal register: every submittal for the chosen job (or all), lowest number first. */
function printRegister(ctx, { jobId, jobById }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const all = filterSubmittals(store.list('submittals'), { jobId }).sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const sum = summarize(all);

  const node = h('div', { class: 'sub-print' }, h('article', { class: 'sub-doc' },
    h('header', { class: 'sub-doc-top' },
      h('div', null, h('div', { class: 'sub-doc-brand' }, co.name || 'Company'), h('div', { class: 'sub-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'sub-doc-right' }, h('div', { class: 'sub-doc-kind' }, 'Submittal register'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, 'Submittal register'),
    h('p', { class: 'sub-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${sum.outstanding} out for review, ${sum.closed} closed of ${sum.total}`].filter(Boolean).join(' · ')),
    all.length ? h('table', null,
      h('thead', null, h('tr', null, ['No.', 'Spec', 'Description', 'Type', 'Submitted', 'Returned', 'Reviewer', 'Status'].map((x) => h('th', null, x)))),
      h('tbody', null, all.map((s) => h('tr', null,
        h('td', null, submittalNo(s)),
        h('td', null, s.specSection || '—'),
        h('td', null, s.description || '—'),
        h('td', null, typeLabel(s.type)),
        h('td', null, s.submittedDate ? ui.fmtDate(s.submittedDate) : '—'),
        h('td', null, s.returnedDate ? ui.fmtDate(s.returnedDate) : '—'),
        h('td', null, s.reviewer || '—'),
        h('td', null, statusLabel(s.status)))))) : h('p', null, 'No submittals logged.')));

  document.body.append(node);
  document.body.classList.add('sub-printing');
  const done = () => { node.remove(); document.body.classList.remove('sub-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
