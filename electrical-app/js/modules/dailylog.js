// Jobsite daily log / diary (#/dailylog): one entry per job per day — weather, the crew on site,
// visitors, deliveries, delays/issues and general notes, with photos. Print a daily report. Pure
// logic: js/lib/dailylog.js.
//   #/dailylog               the list (filtered by job)
//   #/dailylog?jobId=:id     the list for one job
import { newDailyLog, findForDay, filterLogs, sortLogs, summarize, crewCount, WEATHER } from '../lib/dailylog.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/dailylog.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/dailylog.css';
  document.head.append(link);
}

export default {
  id: 'dailylog',
  title: 'Daily log',
  icon: 'book',
  group: 'field',
  perm: 'jobs',
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
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input dl-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/dailylog' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  function draw() {
    ui.clear(host);
    const all = store.list('dailyLogs');
    const rows = sortLogs(filterLogs(all, { jobId }));
    const sum = summarize(rows);

    h(host, null,
      h('div', { class: 'grid dl-stats' },
        ui.stat({ label: 'Entries', value: String(sum.total), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'Days with crew', value: String(sum.withCrew) }),
        ui.stat({ label: 'Days with delays', value: String(sum.withDelays), tone: sum.withDelays ? 'warning' : 'neutral' })),
      h('div', { class: 'row dl-toolbar' },
        jobSelect,
        ui.button('Print report', { icon: 'printer', onClick: () => printReport(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('New entry', { variant: 'primary', icon: 'plus', onClick: () => openDay(ctx, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      tableHost);

    ui.clear(tableHost);
    tableHost.append(ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (l) => ui.fmtDate(l.date), sort: (l) => l.date || '' },
        { key: 'job', label: 'Job', render: (l) => jobLabel(jobById.get(l.jobId)), sort: (l) => jobById.get(l.jobId)?.number || '' },
        { key: 'weather', label: 'Weather', render: (l) => [l.weather, l.temperature].filter(Boolean).join(', ') || '—' },
        { key: 'crew', label: 'Crew', align: 'right', render: (l) => String(crewCount(l)), sort: (l) => crewCount(l) },
        { key: 'delays', label: 'Delays', render: (l) => ((l.delays || '').trim() ? ui.badge('noted', 'warning') : '—') },
        { key: 'photos', label: 'Photos', align: 'right', render: (l) => String((l.photos || []).length) },
      ],
      rows,
      onRowClick: (l) => openDay(ctx, { id: l.id, onDraw: draw }),
      empty: ui.empty({
        icon: 'book',
        title: all.length ? 'No entries for this job' : 'No daily logs yet',
        text: all.length ? 'Start a day entry for this job.' : 'Keep a site diary: one entry per job per day with weather, crew on site, deliveries and any delays — the record you reach for in a dispute.',
        action: ui.button('New entry', { variant: 'primary', icon: 'plus', onClick: () => openDay(ctx, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
      }),
    }));
  }

  root.append(ui.page({
    title: 'Daily log',
    subtitle: 'A site diary: one entry per job per day, with weather, crew, deliveries and delays.',
    actions: [ui.button('New entry', { variant: 'primary', icon: 'plus', onClick: () => openDay(ctx, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('dailyLogs', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function openDay(ctx, { id = null, jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  let log = id ? store.get('dailyLogs', id) : null;
  if (id && !log) { ui.toast('That entry is gone.', 'error'); return; }
  if (!log) log = newDailyLog({ job: jobId ? store.get('jobs', jobId) : null, date: ui.today(), by: store.actorId });
  log.photos = log.photos || [];
  log.crewIds = log.crewIds || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const employees = store.list('employees').sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const weatherList = h('datalist', { id: 'dl-weather' }, WEATHER.map((w) => h('option', { value: w })));

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: log.jobId || '', options: [{ value: '', label: '— none —' }, ...jobs.map((j) => ({ value: j.id, label: jobLabel(j) }))] },
    { label: 'Date', name: 'date', type: 'date', value: log.date, required: true },
    { label: 'Weather', name: 'weather', value: log.weather, placeholder: 'Clear' },
    { label: 'Temperature', name: 'temperature', value: log.temperature, placeholder: 'e.g. -5 °C' },
    { label: 'Visitors', name: 'visitors', type: 'textarea', value: log.visitors, span: true, placeholder: 'Inspector, GC, owner…' },
    { label: 'Deliveries', name: 'deliveries', type: 'textarea', value: log.deliveries, span: true, placeholder: 'Material and equipment that arrived' },
    { label: 'Delays / issues', name: 'delays', type: 'textarea', value: log.delays, span: true, placeholder: 'Weather, access, missing material, RFIs…' },
    { label: 'General notes', name: 'notes', type: 'textarea', value: log.notes, span: true },
  ]);
  grid.querySelector('[name="weather"]')?.setAttribute('list', 'dl-weather');

  // Crew present: a checkbox per employee, kept on log.crewIds.
  const crewSet = new Set(log.crewIds);
  const crewBox = h('div', { class: 'dl-crew' }, employees.length
    ? employees.map((e) => {
      const cb = h('input', { type: 'checkbox', checked: crewSet.has(e.id), onChange: () => { cb.checked ? crewSet.add(e.id) : crewSet.delete(e.id); } });
      return h('label', { class: 'dl-crew-item' }, cb, h('span', null, e.name || 'Employee'));
    })
    : h('p', { class: 'muted' }, 'No employees yet — add them in Employees.'));

  const photos = h('div', null,
    h('h3', { class: 'dl-h3' }, 'Photos'),
    photoStrip({ photos: log.photos, max: 12, label: 'Add photo', toast: ui.toast }));

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() },
    grid, weatherList,
    h('div', null, h('h3', { class: 'dl-h3' }, 'Crew on site'), crewBox),
    photos);

  const collect = () => {
    const v = ui.readForm(body);
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || log.clientId || null,
      date: v.date || null, weather: v.weather || '', temperature: v.temperature || '',
      crewIds: [...crewSet], visitors: v.visitors || '', deliveries: v.deliveries || '',
      delays: v.delays || '', notes: v.notes || '', photos: log.photos,
    };
  };

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this daily log entry?', { okLabel: 'Delete' }))) return;
    store.remove('dailyLogs', id); ui.toast('Entry deleted'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? `Daily log · ${log.date || ''}` : 'New daily log',
    body,
    actions: [
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      h('span', { class: 'grow' }),
      ui.button('Save', { variant: 'primary', icon: 'check', onClick: () => {
        if (!body.reportValidity()) return;
        const patch = collect();
        if (!patch.date) { ui.toast('Pick a date', 'error'); return; }
        // One entry per job per day: if a different entry already exists for this job+date, warn.
        const clash = findForDay(store.list('dailyLogs'), patch.jobId, patch.date);
        if (clash && clash.id !== id) { ui.toast('A log for this job and date already exists.', 'error', 4000); return; }
        if (id) store.update('dailyLogs', id, patch);
        else { const rec = store.add('dailyLogs', { ...log, ...patch }); id = rec.id; }
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
  const rows = sortLogs(filterLogs(store.list('dailyLogs'), { jobId }));
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const empName = (eid) => (eid ? store.get('employees', eid)?.name || '' : '');
  const crewLine = (l) => (l.crewIds || []).map(empName).filter(Boolean).join(', ');

  const node = h('div', { class: 'dl-print' }, h('article', { class: 'dl-doc' },
    h('header', { class: 'dl-doc-top' },
      h('div', null, h('div', { class: 'dl-doc-brand' }, co.name || 'Company'), h('div', { class: 'dl-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'dl-doc-right' }, h('div', { class: 'dl-doc-kind' }, 'Daily log'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, 'Jobsite daily report'),
    h('p', { class: 'dl-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${rows.length} ${rows.length === 1 ? 'day' : 'days'}`].filter(Boolean).join(' · ')),
    rows.length ? rows.map((l) => h('section', { class: 'dl-doc-day' },
      h('h2', null, ui.fmtDate(l.date), h('span', { class: 'dl-doc-weather' }, [l.weather, l.temperature].filter(Boolean).join(', '))),
      !job ? h('p', { class: 'dl-doc-small' }, jobLabel(jobById.get(l.jobId))) : null,
      h('table', null, h('tbody', null,
        crewLine(l) ? h('tr', null, h('th', null, 'Crew'), h('td', null, crewLine(l))) : null,
        (l.visitors || '').trim() ? h('tr', null, h('th', null, 'Visitors'), h('td', null, l.visitors)) : null,
        (l.deliveries || '').trim() ? h('tr', null, h('th', null, 'Deliveries'), h('td', null, l.deliveries)) : null,
        (l.delays || '').trim() ? h('tr', null, h('th', null, 'Delays / issues'), h('td', null, l.delays)) : null,
        (l.notes || '').trim() ? h('tr', null, h('th', null, 'Notes'), h('td', null, l.notes)) : null)),
      (l.photos || []).length ? h('div', { class: 'dl-doc-photos' }, l.photos.map((p) => h('figure', null, h('img', { src: p.dataUrl, alt: '' }), p.caption ? h('figcaption', null, p.caption) : null))) : null))
      : h('p', null, 'No daily log entries yet.')));

  document.body.append(node);
  document.body.classList.add('dl-printing');
  const done = () => { node.remove(); document.body.classList.remove('dl-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
