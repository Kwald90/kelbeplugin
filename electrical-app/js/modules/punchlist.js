// Punch list / deficiencies (#/punchlist): the end-of-job snag list. Deficiencies on a job with an
// area, description, trade, severity and open/closed status, assigned to an employee, due by a date,
// with before/after photos. Mark an item resolved (with an optional photo) and print a punch report
// grouped by area. Pure logic: js/lib/punchlist.js.
//   #/punchlist              the list (filtered by job + status)
//   #/punchlist?jobId=:id    the list for one job
import { newPunchItem, resolvePatch, reopenPatch, isOpen, isOverdue, filterItems, sortItems, groupByArea, summarize, severityLabel, punchLabel, SEVERITIES, TRADES } from '../lib/punchlist.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/punchlist.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/punchlist.css';
  document.head.append(link);
}

export default {
  id: 'punchlist',
  title: 'Punch list',
  icon: 'list',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const severityTone = { high: 'danger', medium: 'warning', low: 'neutral' };

function listView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  let jobId = query.jobId || '';
  let status = 'open';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const empById = new Map(store.list('employees').map((e) => [e.id, e]));
  const empName = (id) => (id ? empById.get(id)?.name || '—' : '—');

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input pl-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/punchlist' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  function draw() {
    ui.clear(host);
    const today = ui.today();
    const all = store.list('punchItems');
    const forJob = filterItems(all, { jobId });
    const shown = sortItems(filterItems(forJob, { status: status === 'all' ? '' : status }));
    const sum = summarize(forJob, today);

    h(host, null,
      h('div', { class: 'grid pl-stats' },
        ui.stat({ label: 'Open', value: String(sum.open), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'High severity', value: String(sum.high), tone: sum.high ? 'danger' : 'neutral' }),
        ui.stat({ label: 'Overdue', value: String(sum.overdue), tone: sum.overdue ? 'warning' : 'neutral' }),
        ui.stat({ label: 'Closed', value: String(sum.closed), hint: 'Resolved' })),
      h('div', { class: 'row pl-toolbar' },
        jobSelect,
        ui.button('Print report', { icon: 'printer', onClick: () => printReport(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('New item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      h('div', { class: 'row pl-tabs' }, ...tabsRow()),
      tableHost);

    drawTable(shown, today);

    function tabsRow() {
      const t = ui.tabs(
        [{ id: 'open', label: `Open (${sum.open})` }, { id: 'closed', label: `Closed (${sum.closed})` }, { id: 'all', label: `All (${sum.total})` }],
        status, (v) => { status = v; draw(); });
      return [t];
    }

    function drawTable(rows, asOf) {
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'sev', label: 'Severity', render: (it) => ui.badge(severityLabel(it.severity), severityTone[it.severity] || 'neutral'), sort: (it) => it.severity },
          { key: 'desc', label: 'Deficiency', render: (it) => h('div', null, h('div', { class: 'pl-desc' }, punchLabel(it)), it.area ? h('div', { class: 'muted pl-sub' }, it.area) : null), sort: (it) => (it.description || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (it) => jobLabel(jobById.get(it.jobId)), sort: (it) => jobById.get(it.jobId)?.number || '' },
          { key: 'trade', label: 'Trade', render: (it) => it.trade || '—' },
          { key: 'assignee', label: 'Assigned', render: (it) => empName(it.assigneeId) },
          { key: 'due', label: 'Due', render: (it) => (it.dueDate ? h('span', { class: isOverdue(it, asOf) ? 'pl-overdue' : null }, ui.fmtDate(it.dueDate)) : '—'), sort: (it) => it.dueDate || '9999' },
          { key: 'status', label: 'Status', render: (it) => (isOpen(it) ? ui.badge('open', 'info') : ui.badge('closed', 'success')), sort: (it) => it.status || 'open' },
        ],
        rows,
        onRowClick: (it) => editItem(ctx, it.id, { onDraw: draw }),
        empty: ui.empty({
          icon: 'list',
          title: all.length ? 'Nothing here' : 'No punch items yet',
          text: all.length ? 'No deficiencies match this job and status.' : 'Log the snags and deficiencies to fix before handover — area, trade, severity and a photo — then work the list down and print it for the client.',
          action: ui.button('New item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'Punch list',
    subtitle: 'Track deficiencies to clear before handover, with photos and a printable report.',
    actions: [ui.button('New item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('punchItems', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function editItem(ctx, id, { jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const it = id ? store.get('punchItems', id) : newPunchItem({ job: jobId ? store.get('jobs', jobId) : null, by: store.actorId, date: ui.today() });
  if (!it) { ui.toast('That item is gone.', 'error'); return; }
  it.photos = it.photos || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const employees = store.list('employees').sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const tradeList = h('datalist', { id: 'pl-trades' }, TRADES.map((t) => h('option', { value: t })));

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: it.jobId || '', options: [{ value: '', label: '— none —' }, ...ui.recordOptions(jobs, (j) => jobLabel(j), '— none —').slice(1)] },
    { label: 'Area / location', name: 'area', value: it.area, placeholder: 'e.g. Level 2, Room 214' },
    { label: 'Trade', name: 'trade', value: it.trade, placeholder: 'Electrical' },
    { label: 'Severity', name: 'severity', type: 'select', value: it.severity || 'medium', options: SEVERITIES.map((s) => ({ value: s.id, label: s.label })) },
    { label: 'Assigned to', name: 'assigneeId', type: 'select', value: it.assigneeId || '', options: [{ value: '', label: '— nobody —' }, ...employees.map((e) => ({ value: e.id, label: e.name || 'Employee' }))] },
    { label: 'Due date', name: 'dueDate', type: 'date', value: it.dueDate },
    { label: 'Description', name: 'description', type: 'textarea', value: it.description, span: true, placeholder: 'What is wrong and what fixing it needs' },
    { label: 'Notes', name: 'notes', type: 'textarea', value: it.notes, span: true },
  ]);
  grid.querySelector('[name="trade"]')?.setAttribute('list', 'pl-trades');

  const photos = h('div', null,
    h('h3', { class: 'pl-h3' }, 'Photos'),
    photoStrip({ photos: it.photos, max: 8, label: 'Add photo', toast: ui.toast }));

  const statusLine = h('div', { class: 'pl-status' });
  const drawStatus = () => {
    ui.clear(statusLine);
    if (isOpen(it)) statusLine.append(ui.badge('open', 'info'));
    else {
      const by = it.resolvedBy ? store.get('employees', it.resolvedBy)?.name : null;
      statusLine.append(ui.badge('resolved', 'success'), h('span', { class: 'muted pl-status-note' }, `${it.resolvedAt ? ui.fmtDate(it.resolvedAt) : ''}${by ? ` · ${by}` : ''}`));
    }
  };
  drawStatus();

  const collect = () => {
    const v = ui.readForm(body);
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || it.clientId || null,
      area: v.area || '', trade: v.trade || '', severity: v.severity || 'medium',
      assigneeId: v.assigneeId || null, dueDate: v.dueDate || null,
      description: v.description || '', notes: v.notes || '', photos: it.photos,
    };
  };
  const persist = (extra = {}) => {
    const patch = { ...collect(), ...extra };
    if (id) return store.update('punchItems', id, patch);
    const rec = store.add('punchItems', { ...it, ...patch });
    id = rec.id;
    return rec;
  };

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, statusLine, grid, tradeList, photos);

  const resolveBtn = ui.button(isOpen(it) ? 'Mark resolved' : 'Reopen', {
    variant: isOpen(it) ? 'primary' : 'ghost', icon: isOpen(it) ? 'check' : 'undo',
    onClick: () => {
      const extra = isOpen(it) ? resolvePatch(it, { by: store.actorId }) : reopenPatch();
      Object.assign(it, extra);
      persist(extra);
      ui.toast(isOpen(it) ? 'Reopened' : 'Marked resolved', 'success');
      sheet.close();
      onDraw?.();
    },
  });

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this punch item?', { okLabel: 'Delete' }))) return;
    store.remove('punchItems', id); ui.toast('Item deleted'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? 'Punch item' : 'New punch item',
    body,
    actions: [
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      h('span', { class: 'grow' }),
      resolveBtn,
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
function printReport(ctx, { jobId, jobById }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const all = filterItems(store.list('punchItems'), { jobId });
  const open = all.filter(isOpen);
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const empName = (eid) => (eid ? store.get('employees', eid)?.name || '' : '');
  const groups = groupByArea(open);
  const sum = summarize(all);

  const node = h('div', { class: 'pl-print' }, h('article', { class: 'pl-doc' },
    h('header', { class: 'pl-doc-top' },
      h('div', null, h('div', { class: 'pl-doc-brand' }, co.name || 'Company'), h('div', { class: 'pl-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'pl-doc-right' }, h('div', { class: 'pl-doc-kind' }, 'Punch list'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, 'Deficiency / punch report'),
    h('p', { class: 'pl-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${open.length} open of ${sum.total}`].filter(Boolean).join(' · ')),
    groups.length ? groups.map((g) => [
      h('h2', null, g.area),
      h('table', null,
        h('thead', null, h('tr', null, ['#', 'Deficiency', 'Trade', 'Severity', 'Assigned', 'Due', 'Done'].map((x) => h('th', null, x)))),
        h('tbody', null, g.items.map((it, i) => h('tr', null,
          h('td', null, i + 1),
          h('td', null, it.description || '—'),
          h('td', null, it.trade || '—'),
          h('td', null, severityLabel(it.severity)),
          h('td', null, empName(it.assigneeId) || '—'),
          h('td', null, it.dueDate ? ui.fmtDate(it.dueDate) : '—'),
          h('td', { class: 'pl-check' }, '☐')))))]) : h('p', null, 'No open deficiencies. The list is clear.')));

  document.body.append(node);
  document.body.classList.add('pl-printing');
  const done = () => { node.remove(); document.body.classList.remove('pl-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
