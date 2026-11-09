// Drawing revision control (#/drawingrevisions): a REGISTER of the construction drawings on a job and
// which revision is current. One row per drawing — number, title, discipline, the rev in force and a
// rev history — with a status (current / superseded / void) and a "mark superseded" action. This is a
// transmittal register, not the heavy drawings/canvas collection. Print a drawing register / transmittal.
// Pure logic: js/lib/drawing-revisions.js.
//   #/drawingrevisions             the register (filtered by job + status)
//   #/drawingrevisions?jobId=:id   the register for one job
import {
  newDrawing, addRevision, markSupersededPatch, markVoidPatch, reinstatePatch,
  isCurrent, latestRev, sortRevHistory, filterDrawings, sortDrawings, currentSet, groupByDiscipline,
  summarize, statusLabel, statusTone, statusRank, disciplineLabel, drawingLabel, DR_STATUSES, DISCIPLINES, MAX_REVISIONS,
} from '../lib/drawing-revisions.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/drawingrevisions.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/drawingrevisions.css';
  document.head.append(link);
}

export default {
  id: 'drawingrevisions',
  title: 'Drawing register',
  icon: 'layers',
  group: 'work',
  perm: 'drawings',
  render(root, ctx) {
    loadCss();
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');

function listView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  let jobId = query.jobId || '';
  let status = 'all';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input dr-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/drawingrevisions' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  function draw() {
    ui.clear(host);
    const all = store.list('drawingRevisions');
    const forJob = filterDrawings(all, { jobId });
    const shown = sortDrawings(filterDrawings(forJob, { status: status === 'all' ? '' : status }));
    const sum = summarize(forJob);

    h(host, null,
      h('div', { class: 'grid dr-stats' },
        ui.stat({ label: 'Current', value: String(sum.current), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs', tone: 'accent' }),
        ui.stat({ label: 'Superseded', value: String(sum.superseded), tone: sum.superseded ? 'warning' : 'neutral' }),
        ui.stat({ label: 'Void', value: String(sum.void) }),
        ui.stat({ label: 'Drawings', value: String(sum.total), hint: 'In the register' })),
      h('div', { class: 'row dr-toolbar' },
        jobSelect,
        ui.button('Print register', { icon: 'printer', onClick: () => printRegister(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('Add drawing', { variant: 'primary', icon: 'plus', onClick: () => editDrawing(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      h('div', { class: 'row dr-tabs' }, tabsRow()),
      tableHost);

    drawTable(shown);

    function tabsRow() {
      return ui.tabs(
        [{ id: 'all', label: `All (${sum.total})` }, { id: 'current', label: `Current (${sum.current})` }, { id: 'superseded', label: `Superseded (${sum.superseded})` }],
        status, (v) => { status = v; draw(); });
    }

    function drawTable(rows) {
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'Drawing', render: (d) => h('div', null, h('div', { class: 'dr-num' }, d.number || '—'), d.title ? h('div', { class: 'muted dr-sub' }, d.title) : null), sort: (d) => (d.number || '').toLowerCase() },
          { key: 'discipline', label: 'Discipline', render: (d) => disciplineLabel(d.discipline) || '—', sort: (d) => d.discipline || '' },
          { key: 'rev', label: 'Rev', align: 'right', render: (d) => h('strong', { class: 'dr-rev' }, latestRev(d) || '—'), sort: (d) => latestRev(d) },
          { key: 'job', label: 'Job', render: (d) => jobLabel(jobById.get(d.jobId)), sort: (d) => jobById.get(d.jobId)?.number || '' },
          { key: 'history', label: 'Revs', align: 'right', render: (d) => String((d.revHistory || []).length) },
          { key: 'status', label: 'Status', render: (d) => ui.badge(statusLabel(d.status), statusTone(d.status)), sort: (d) => statusRank(d.status) },
        ],
        rows,
        onRowClick: (d) => editDrawing(ctx, d.id, { onDraw: draw }),
        empty: ui.empty({
          icon: 'layers',
          title: all.length ? 'Nothing here' : 'No drawings in the register yet',
          text: all.length ? 'No drawings match this job and status.' : 'Keep the current revision of every construction drawing straight — number, title, discipline and the rev in force — so the crew builds from the right set. Log each revision as it comes in and print a register for the trailer.',
          action: ui.button('Add drawing', { variant: 'primary', icon: 'plus', onClick: () => editDrawing(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'Drawing register',
    subtitle: 'Track the current revision of every construction drawing, with a rev history and a printable transmittal.',
    actions: [ui.button('Add drawing', { variant: 'primary', icon: 'plus', onClick: () => editDrawing(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('drawingRevisions', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function editDrawing(ctx, id, { jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const d = id ? store.get('drawingRevisions', id) : newDrawing({ job: jobId ? store.get('jobs', jobId) : null, by: store.actorId, rev: '', discipline: 'E' });
  if (!d) { ui.toast('That drawing is gone.', 'error'); return; }
  d.revHistory = d.revHistory || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const discList = h('datalist', { id: 'dr-disciplines' }, DISCIPLINES.map((x) => h('option', { value: x.id }, x.label)));

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: d.jobId || '', options: [{ value: '', label: '— none —' }, ...ui.recordOptions(jobs, (j) => jobLabel(j), '— none —').slice(1)] },
    { label: 'Drawing number', name: 'number', value: d.number, placeholder: 'e.g. E-101' },
    { label: 'Title', name: 'title', value: d.title, placeholder: 'e.g. Second-floor power plan' },
    { label: 'Discipline', name: 'discipline', value: d.discipline || 'E', placeholder: 'E' },
    { label: 'Status', name: 'status', type: 'select', value: d.status || 'current', options: DR_STATUSES.map((s) => ({ value: s.id, label: s.label })) },
    { label: 'Notes', name: 'notes', type: 'textarea', value: d.notes, span: true },
  ]);
  grid.querySelector('[name="discipline"]')?.setAttribute('list', 'dr-disciplines');

  // --- revision history ---
  const revHost = h('div', { class: 'dr-revs' });
  const drawRevs = () => {
    ui.clear(revHost);
    const hist = sortRevHistory(d.revHistory);
    if (!hist.length) { revHost.append(h('div', { class: 'muted dr-empty' }, 'No revisions logged yet. Add the first one below.')); return; }
    revHost.append(h('div', { class: 'dr-revhead muted' }, h('span', null, 'Rev'), h('span', null, 'Date'), h('span', null, 'Description'), h('span', null, 'From'), h('span', null, '')));
    hist.forEach((e) => revHost.append(h('div', { class: ['dr-revrow', e.superseded ? 'superseded' : 'live'] },
      h('span', { class: 'dr-revtag' }, e.rev || '—', e.superseded ? null : ui.badge('current', 'success')),
      h('span', null, e.date ? ui.fmtDate(e.date) : '—'),
      h('span', { class: 'dr-revdesc' }, e.description || '—'),
      h('span', null, e.receivedFrom || '—'),
      ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Remove this revision', onClick: () => {
        d.revHistory = d.revHistory.filter((x) => x.id !== e.id);
        d.currentRev = latestRev({ ...d, currentRev: '' });
        persist({ revHistory: d.revHistory, currentRev: d.currentRev });
        drawRevs();
      } }))));
  };
  drawRevs();

  const revForm = (() => {
    const rev = h('input', { class: 'input', placeholder: 'e.g. 2', 'aria-label': 'New revision' });
    const date = h('input', { class: 'input', type: 'date', 'aria-label': 'Revision date' });
    const desc = h('input', { class: 'input', placeholder: 'What changed', 'aria-label': 'Revision description' });
    const from = h('input', { class: 'input', placeholder: 'Received from (engineer, architect…)', 'aria-label': 'Received from' });
    const add = ui.button('Add revision', { icon: 'plus', onClick: () => {
      if (!rev.value.trim()) { ui.toast('Give the revision a number or letter', 'error'); rev.focus(); return; }
      if ((d.revHistory || []).length >= MAX_REVISIONS) { ui.toast(`Up to ${MAX_REVISIONS} revisions`, 'error'); return; }
      const patch = addRevision(d, { rev: rev.value.trim(), date: date.value || null, description: desc.value.trim(), receivedFrom: from.value.trim() });
      Object.assign(d, patch);
      persist(patch);
      // reflect the new current status in the form
      const statusSel = grid.querySelector('[name="status"]'); if (statusSel) statusSel.value = 'current';
      rev.value = ''; date.value = ''; desc.value = ''; from.value = '';
      drawRevs();
      ui.toast(`Rev ${patch.currentRev} logged`, 'success');
    } });
    return h('div', { class: 'dr-addrev' }, h('div', { class: 'dr-addrev-grid' }, rev, date, desc, from), add);
  })();

  const collect = () => {
    const v = ui.readForm(body);
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || d.clientId || null,
      number: (v.number || '').slice(0, 80),
      title: (v.title || '').slice(0, 200),
      discipline: (v.discipline || '').slice(0, 40),
      status: v.status || 'current',
      notes: v.notes || '',
      revHistory: d.revHistory,
      currentRev: d.currentRev,
    };
  };
  const persist = (extra = {}) => {
    const patch = { ...collect(), ...extra };
    if (id) return store.update('drawingRevisions', id, patch);
    const rec = store.add('drawingRevisions', { ...d, ...patch });
    id = rec.id;
    return rec;
  };

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() },
    grid, discList,
    h('h3', { class: 'dr-h3' }, 'Revision history'),
    revHost,
    revForm);

  const supersedeBtn = ui.button(isCurrent(d) ? 'Mark superseded' : 'Mark current', {
    variant: isCurrent(d) ? 'ghost' : 'primary', icon: isCurrent(d) ? 'archive' : 'check',
    onClick: () => {
      const patch = isCurrent(d) ? markSupersededPatch() : reinstatePatch();
      Object.assign(d, patch);
      persist(patch);
      const statusSel = grid.querySelector('[name="status"]'); if (statusSel) statusSel.value = d.status;
      ui.toast(isCurrent(d) ? 'Marked current' : 'Marked superseded', 'success');
      supersedeBtn.textContent = isCurrent(d) ? 'Mark superseded' : 'Mark current';
      onDraw?.();
    },
  });

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this drawing from the register?', { okLabel: 'Delete' }))) return;
    store.remove('drawingRevisions', id); ui.toast('Removed'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? drawingLabel(d) : 'Add drawing',
    body,
    actions: [
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      id ? ui.button('Void', { variant: 'ghost', onClick: () => { Object.assign(d, markVoidPatch()); persist(markVoidPatch()); const s = grid.querySelector('[name="status"]'); if (s) s.value = 'void'; ui.toast('Marked void'); onDraw?.(); } }) : null,
      h('span', { class: 'grow' }),
      id ? supersedeBtn : null,
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

// ---------- print: a drawing register / transmittal ----------
function printRegister(ctx, { jobId, jobById }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const all = filterDrawings(store.list('drawingRevisions'), { jobId });
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const sum = summarize(all);
  const current = currentSet(all);
  const groups = groupByDiscipline(current);

  const node = h('div', { class: 'dr-print' }, h('article', { class: 'dr-doc' },
    h('header', { class: 'dr-doc-top' },
      h('div', null, h('div', { class: 'dr-doc-brand' }, co.name || 'Company'), h('div', { class: 'dr-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'dr-doc-right' }, h('div', { class: 'dr-doc-kind' }, 'Drawing register'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, 'Current drawing register'),
    h('p', { class: 'dr-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${sum.current} current of ${sum.total}`].filter(Boolean).join(' · ')),
    groups.length ? groups.map((g) => [
      h('h2', null, g.label),
      h('table', null,
        h('thead', null, h('tr', null, ['Number', 'Title', 'Rev', 'Date', 'Received from'].map((x) => h('th', null, x)))),
        h('tbody', null, g.items.map((d) => {
          const live = sortRevHistory(d.revHistory).find((e) => !e.superseded) || sortRevHistory(d.revHistory)[0] || {};
          return h('tr', null,
            h('td', null, d.number || '—'),
            h('td', null, d.title || '—'),
            h('td', { class: 'dr-c' }, latestRev(d) || '—'),
            h('td', null, live.date ? ui.fmtDate(live.date) : '—'),
            h('td', null, live.receivedFrom || '—'));
        })))]) : h('p', null, 'No current drawings in the register.'),
    sum.superseded || sum.void ? h('p', { class: 'dr-doc-small dr-doc-note' }, `${sum.superseded} superseded and ${sum.void} void drawing(s) are not listed above.`) : null));

  document.body.append(node);
  document.body.classList.add('dr-printing');
  const done = () => { node.remove(); document.body.classList.remove('dr-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
