// Procurement / long-lead log (#/procurement): the gear with long lead times on a job — switchgear,
// transformers, panels, big breakers — that has to be ordered early. One row per item: a job link, a
// description, the vendor, an optional PO link (by id), quantity, where it is in the buying pipeline
// (to-order … delivered), order/promised/need-by dates, lead-time weeks, a delivered flag and notes.
// The log flags items at risk (promised after they are needed, or a date already blown) and prints.
// Pure logic: js/lib/procurement.js.
//   #/procurement             the log (filtered by job + status)
//   #/procurement?jobId=:id   the log for one job
import {
  newProcurementItem, isDelivered, atRiskReason, isAtRisk, riskLabel, markDeliveredPatch, reopenPatch,
  filterItems, sortItems, summarize, leadTimeLabel, procurementLabel, statusLabel, statusTone, statusRank, PROC_STATUSES,
} from '../lib/procurement.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/procurement.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/procurement.css';
  document.head.append(link);
}

export default {
  id: 'procurement',
  title: 'Procurement',
  icon: 'truck',
  group: 'work',
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
  let status = 'outstanding';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input pr-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/procurement' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  function draw() {
    ui.clear(host);
    const asOf = ui.today();
    const all = store.list('procurementItems');
    const forJob = filterItems(all, { jobId });
    const shown = sortItems(filterItems(forJob, { status: status === 'all' ? '' : status }), asOf);
    const sum = summarize(forJob, asOf);

    h(host, null,
      h('div', { class: 'grid pr-stats' },
        ui.stat({ label: 'Outstanding', value: String(sum.outstanding), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'At risk', value: String(sum.atRisk), tone: sum.atRisk ? 'danger' : 'neutral' }),
        ui.stat({ label: 'Delivered', value: String(sum.delivered), tone: 'success' }),
        ui.stat({ label: 'Items', value: String(sum.total), hint: 'In the log' })),
      h('div', { class: 'row pr-toolbar' },
        jobSelect,
        ui.button('Print log', { icon: 'printer', onClick: () => printLog(ctx, { jobId, jobById }) }),
        h('span', { class: 'grow' }),
        ui.button('Add item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })),
      h('div', { class: 'row pr-tabs' }, tabsRow()),
      tableHost);

    drawTable(shown, asOf);

    function tabsRow() {
      return ui.tabs(
        [{ id: 'outstanding', label: `Outstanding (${sum.outstanding})` }, { id: 'delivered', label: `Delivered (${sum.delivered})` }, { id: 'all', label: `All (${sum.total})` }],
        status, (v) => { status = v; draw(); });
    }

    function drawTable(rows, day) {
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'item', label: 'Item', render: (it) => h('div', null, h('div', { class: 'pr-desc' }, procurementLabel(it)), it.vendor ? h('div', { class: 'muted pr-sub' }, it.vendor) : null), sort: (it) => (it.description || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (it) => jobLabel(jobById.get(it.jobId)), sort: (it) => jobById.get(it.jobId)?.number || '' },
          { key: 'qty', label: 'Qty', align: 'right', render: (it) => (it.quantity ?? '—') },
          { key: 'lead', label: 'Lead', align: 'right', render: (it) => leadTimeLabel(it.leadTimeWeeks) || '—', sort: (it) => Number(it.leadTimeWeeks) || 0 },
          { key: 'needby', label: 'Need by', render: (it) => (it.needByDate ? h('span', { class: isAtRisk(it, day) ? 'pr-risk' : null }, ui.fmtDate(it.needByDate)) : '—'), sort: (it) => it.needByDate || '9999' },
          { key: 'promised', label: 'Promised', render: (it) => (it.promisedDate ? ui.fmtDate(it.promisedDate) : '—'), sort: (it) => it.promisedDate || '9999' },
          { key: 'status', label: 'Status', render: (it) => {
            const reason = atRiskReason(it, day);
            return h('span', { class: 'pr-statuscell' }, ui.badge(statusLabel(it.status), statusTone(it.status)), reason ? ui.badge('at risk', 'danger') : null);
          }, sort: (it) => statusRank(it.status) },
        ],
        rows,
        onRowClick: (it) => editItem(ctx, it.id, { onDraw: draw }),
        empty: ui.empty({
          icon: 'truck',
          title: all.length ? 'Nothing here' : 'No long-lead items yet',
          text: all.length ? 'No items match this job and status.' : 'Track the gear with long lead times — switchgear, transformers, panels — so nothing holds up the job. Log the vendor, the PO, the need-by date and the lead time, and the log flags anything at risk of being late.',
          action: ui.button('Add item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'Procurement log',
    subtitle: 'Track long-lead gear from quote to delivery, and flag anything at risk of being late.',
    actions: [ui.button('Add item', { variant: 'primary', icon: 'plus', onClick: () => editItem(ctx, null, { jobId: jobId && jobId !== '__none' ? jobId : null, onDraw: draw }) })],
  }, host));
  draw();
  return store.on('procurementItems', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function editItem(ctx, id, { jobId = null, onDraw } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const it = id ? store.get('procurementItems', id) : newProcurementItem({ job: jobId ? store.get('jobs', jobId) : null, by: store.actorId });
  if (!it) { ui.toast('That item is gone.', 'error'); return; }
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const orderJobId = it.jobId || jobId || null;
  const pos = store.list('purchaseOrders', (p) => (orderJobId ? p.jobId === orderJobId : true)).sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const poOpts = [{ value: '', label: '— none —' }, ...pos.map((p) => ({ value: p.id, label: `${p.number || 'PO'}${p.vendor ? ` · ${p.vendor}` : ''}` }))];
  if (it.purchaseOrderId && !pos.some((p) => p.id === it.purchaseOrderId)) poOpts.push({ value: it.purchaseOrderId, label: '(linked PO)' });

  const grid = ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', value: it.jobId || '', options: [{ value: '', label: '— none —' }, ...ui.recordOptions(jobs, (j) => jobLabel(j), '— none —').slice(1)] },
    { label: 'Item description', name: 'description', value: it.description, placeholder: 'e.g. 600A main switchgear', span: true },
    { label: 'Vendor', name: 'vendor', value: it.vendor, placeholder: 'e.g. Schneider / EECOL' },
    { label: 'Purchase order', name: 'purchaseOrderId', type: 'select', value: it.purchaseOrderId || '', options: poOpts },
    { label: 'Quantity', name: 'quantity', type: 'number', value: it.quantity ?? 1, min: 0, step: 1 },
    { label: 'Status', name: 'status', type: 'select', value: it.status || 'to-order', options: PROC_STATUSES.map((s) => ({ value: s.id, label: s.label })) },
    { label: 'Lead time (weeks)', name: 'leadTimeWeeks', type: 'number', value: it.leadTimeWeeks ?? '', min: 0, step: 1 },
    { label: 'Order date', name: 'orderDate', type: 'date', value: it.orderDate },
    { label: 'Promised date', name: 'promisedDate', type: 'date', value: it.promisedDate },
    { label: 'Need by', name: 'needByDate', type: 'date', value: it.needByDate },
    { label: 'Notes', name: 'notes', type: 'textarea', value: it.notes, span: true },
  ]);

  const riskLine = h('div', { class: 'pr-riskline' });
  const drawRisk = () => {
    ui.clear(riskLine);
    const reason = atRiskReason({ ...it, ...readValues() }, ui.today());
    if (isDelivered({ ...it, ...readValues() })) riskLine.append(ui.badge('Delivered', 'success'));
    else if (reason) riskLine.append(ui.badge('At risk', 'danger'), h('span', { class: 'muted pr-risknote' }, riskLabel(reason)));
    else riskLine.append(ui.badge('On track', 'neutral'));
  };
  const readValues = () => {
    const v = ui.readForm(body);
    return {
      status: v.status || 'to-order',
      promisedDate: v.promisedDate || null,
      needByDate: v.needByDate || null,
      delivered: (v.status || '') === 'delivered' ? true : it.delivered,
    };
  };

  const collect = () => {
    const v = ui.readForm(body);
    const status = v.status || 'to-order';
    return {
      jobId: v.jobId || null,
      clientId: (v.jobId && store.get('jobs', v.jobId)?.clientId) || it.clientId || null,
      description: (v.description || '').slice(0, 300),
      vendor: (v.vendor || '').slice(0, 200),
      purchaseOrderId: v.purchaseOrderId || null,
      quantity: v.quantity === '' || v.quantity == null ? 1 : Number(v.quantity),
      status,
      leadTimeWeeks: v.leadTimeWeeks === '' || v.leadTimeWeeks == null ? null : Number(v.leadTimeWeeks),
      orderDate: v.orderDate || null,
      promisedDate: v.promisedDate || null,
      needByDate: v.needByDate || null,
      delivered: status === 'delivered' ? true : (status === 'to-order' || status === 'quoted' || status === 'ordered' || status === 'released' || status === 'shipped' ? false : it.delivered),
      deliveredDate: status === 'delivered' ? (it.deliveredDate || ui.today()) : null,
      notes: v.notes || '',
    };
  };
  const persist = (extra = {}) => {
    const patch = { ...collect(), ...extra };
    if (id) return store.update('procurementItems', id, patch);
    const rec = store.add('procurementItems', { ...it, ...patch });
    id = rec.id;
    return rec;
  };

  const body = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, riskLine, grid);
  body.addEventListener('input', drawRisk);
  body.addEventListener('change', drawRisk);
  drawRisk();

  const deliverBtn = ui.button(isDelivered(it) ? 'Reopen' : 'Mark delivered', {
    variant: isDelivered(it) ? 'ghost' : 'primary', icon: isDelivered(it) ? 'undo' : 'check',
    onClick: () => {
      const extra = isDelivered(it) ? reopenPatch() : markDeliveredPatch({ date: ui.today() });
      Object.assign(it, extra);
      persist(extra);
      ui.toast(isDelivered(it) ? 'Marked delivered' : 'Reopened', 'success');
      sheet.close();
      onDraw?.();
    },
  });

  const remove = async () => {
    if (!id) { sheet.close(); return; }
    if (!(await ui.confirmDialog('Delete this item from the log?', { okLabel: 'Delete' }))) return;
    store.remove('procurementItems', id); ui.toast('Removed'); sheet.close(); onDraw?.();
  };

  const sheet = ui.openSheet({
    title: id ? procurementLabel(it) : 'Add long-lead item',
    body,
    actions: [
      id ? ui.button('Delete', { variant: 'ghost danger', onClick: remove }) : null,
      h('span', { class: 'grow' }),
      id ? deliverBtn : null,
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

// ---------- print: a procurement / long-lead log ----------
function printLog(ctx, { jobId, jobById }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const asOf = ui.today();
  const co = store.settings().company || {};
  const all = filterItems(store.list('procurementItems'), { jobId });
  const job = jobId && jobId !== '__none' ? jobById.get(jobId) : null;
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const sum = summarize(all, asOf);
  const rows = sortItems(all, asOf);
  const poNum = (pid) => (pid ? store.get('purchaseOrders', pid)?.number || '' : '');

  const node = h('div', { class: 'pr-print' }, h('article', { class: 'pr-doc' },
    h('header', { class: 'pr-doc-top' },
      h('div', null, h('div', { class: 'pr-doc-brand' }, co.name || 'Company'), h('div', { class: 'pr-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'pr-doc-right' }, h('div', { class: 'pr-doc-kind' }, 'Procurement log'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, 'Long-lead procurement log'),
    h('p', { class: 'pr-doc-small' }, [job ? jobLabel(job) : 'All jobs', client?.name, job?.address, `${sum.outstanding} outstanding, ${sum.atRisk} at risk, ${sum.delivered} delivered`].filter(Boolean).join(' · ')),
    rows.length ? h('table', null,
      h('thead', null, h('tr', null, ['Item', 'Vendor', 'PO', 'Qty', 'Lead', 'Order', 'Promised', 'Need by', 'Status'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((it) => {
        const reason = atRiskReason(it, asOf);
        return h('tr', { class: reason ? 'pr-row-risk' : null },
          h('td', null, procurementLabel(it)),
          h('td', null, it.vendor || '—'),
          h('td', null, poNum(it.purchaseOrderId) || '—'),
          h('td', { class: 'pr-c' }, it.quantity ?? '—'),
          h('td', null, leadTimeLabel(it.leadTimeWeeks) || '—'),
          h('td', null, it.orderDate ? ui.fmtDate(it.orderDate) : '—'),
          h('td', null, it.promisedDate ? ui.fmtDate(it.promisedDate) : '—'),
          h('td', null, it.needByDate ? ui.fmtDate(it.needByDate) : '—'),
          h('td', null, statusLabel(it.status), reason ? h('div', { class: 'pr-doc-risk' }, riskLabel(reason)) : null));
      }))) : h('p', null, 'No items in the log.')));

  document.body.append(node);
  document.body.classList.add('pr-printing');
  const done = () => { node.remove(); document.body.classList.remove('pr-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
