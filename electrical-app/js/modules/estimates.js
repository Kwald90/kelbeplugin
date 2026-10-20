// Estimates (S17): list, builder with price-book line editor, takeoff from drawings, print.
import { docTotals, moneyFormatter } from '../lib/money.js';
import { newDocTax } from '../lib/tax.js';
import { mergeForTakeoff, sortSheets } from '../lib/plansets.js';
import { lineEditor, taxEditor, totalsPanel, previewDocument, debounce, clientName } from '../lib/doc-view.js';
import { moduleOn } from '../lib/modules.js';
import { qboBadge, noTaxReasonPicker, lookupAction } from '../lib/qbo-ui.js';

const STATUSES = ['draft', 'sent', 'accepted', 'declined'];

export default {
  id: 'estimates',
  title: 'Estimates',
  icon: 'file-text',
  group: 'money',
  perm: 'estimates',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (sub === 'new') return createNew(ctx);
    if (sub) return renderDetail(root, ctx, sub);
    return renderList(root, ctx);
  },
};

// ---------- list ----------
function renderList(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let tab = ctx.query.status || 'all';
  let q = '';
  const money = moneyFormatter(store.settings());
  const body = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(body);
    const all = store.list('estimates');
    const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((e) => e.status === s).length]));
    const openValue = all.filter((e) => e.status === 'sent').reduce((s, e) => s + docTotals(e).totalCents, 0);
    const wonValue = all.filter((e) => e.status === 'accepted').reduce((s, e) => s + docTotals(e).totalCents, 0);
    const decided = counts.accepted + counts.declined;
    h(body, null,
      h('div', { class: 'grid money-stats' },
        ui.stat({ label: 'Awaiting answer', value: money(openValue, { whole: true }), hint: `${counts.sent} sent` }),
        ui.stat({ label: 'Accepted', value: money(wonValue, { whole: true }), hint: `${counts.accepted} estimates`, tone: 'success' }),
        ui.stat({ label: 'Win rate', value: decided ? `${Math.round((counts.accepted / decided) * 100)}%` : '—', hint: `${decided} decided` })),
      h('div', { class: 'row' },
        ui.tabs([{ id: 'all', label: `All ${all.length}` }, ...STATUSES.map((s) => ({ id: s, label: `${cap(s)} ${counts[s]}` }))], tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }),
        ui.searchBox('Search estimates', (v) => { q = v; drawTable(); }, q)),
      tableHost);
    drawTable();
    function drawTable() {
      const n = q.trim().toLowerCase();
      const r = all.filter((e) => (tab === 'all' || e.status === tab) &&
        (!n || [e.number, e.title, clientName(store, e.clientId)].some((s) => (s || '').toLowerCase().includes(n))));
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'Number', render: (e) => h('span', { class: 'mono' }, e.number), sort: (e) => e.number },
          { key: 'client', label: 'Client', render: (e) => clientName(store, e.clientId), sort: (e) => clientName(store, e.clientId) },
          { key: 'title', label: 'Title', render: (e) => e.title || '—', sort: (e) => e.title || '' },
          { key: 'total', label: 'Total', align: 'right', render: (e) => money(docTotals(e).totalCents), sort: (e) => docTotals(e).totalCents },
          { key: 'status', label: 'Status', render: (e) => h('span', { class: 'row-inline' }, ui.statusBadge(e.status), qboBadge(ctx, 'estimates', e.id, { record: e })), sort: (e) => e.status },
          { key: 'validUntil', label: 'Valid until', render: (e) => validCell(ui, e), sort: (e) => e.validUntil || '' },
        ],
        rows: r,
        onRowClick: (e) => nav('#/estimates/' + e.id),
        empty: ui.empty({ icon: 'file-text', title: all.length ? 'No estimates match' : 'No estimates yet',
          text: all.length ? 'Try another tab or search.' : 'Build a quote from the price book, or run a takeoff from a drawing.',
          action: all.length ? null : ui.button('New estimate', { variant: 'primary', icon: 'plus', href: '#/estimates/new' }) }),
      }));
    }
  };
  const tableHost = h('div');

  root.append(ui.page({
    title: 'Estimates', subtitle: 'Quotes built from the price book and drawing takeoffs',
    actions: [ui.button('New estimate', { variant: 'primary', icon: 'plus', href: '#/estimates/new' })],
  }, body));
  draw();
  return store.on('estimates', draw);
}

function validCell(ui, e) {
  if (!e.validUntil) return '—';
  const d = ui.daysUntil(e.validUntil);
  const txt = ui.fmtDate(e.validUntil);
  if (e.status === 'sent' && d < 0) return ui.h('span', null, txt, ' ', ui.badge('expired', 'danger'));
  if (e.status === 'sent' && d <= 7) return ui.h('span', null, txt, ' ', ui.badge(`${d}d left`, 'warning'));
  return txt;
}

// ---------- new (and takeoff) ----------
function createNew(ctx) {
  const { store, ui, query } = ctx;
  const s = store.settings();
  const rec = {
    number: store.nextNumber('estimate'),
    clientId: query.clientId || null,
    jobId: query.jobId || null,
    title: '',
    status: 'draft',
    lines: [],
    labourRateCents: s.labourRateCents ?? 9500,
    markupPct: 0,
    ...newDocTax(s), // { taxProvince, taxTreatment, taxes, taxPct }
    notes: '',
    validUntil: ui.today(30),
  };
  if (query.jobId) {
    const job = store.get('jobs', query.jobId);
    if (job) { rec.clientId = rec.clientId || job.clientId || null; rec.title = job.title || ''; }
  }
  if (query.leadId) {
    const lead = store.get('leads', query.leadId);
    if (lead) { rec.clientId = rec.clientId || lead.clientId || null; rec.title = lead.title || ''; rec.leadId = lead.id; }
  }
  let summary = null;
  if (query.fromDrawing) {
    const d = store.get('drawings', query.fromDrawing);
    if (d) {
      const t = takeoff(store, d);
      rec.lines = t.lines;
      rec.drawingId = d.id;
      if (d.jobId) {
        const job = store.get('jobs', d.jobId);
        rec.jobId = d.jobId;
        if (job) { rec.clientId = rec.clientId || job.clientId || null; }
        rec.title = rec.title || `${job?.title || d.name} — takeoff`;
      } else rec.title = rec.title || `${d.name} — takeoff`;
      summary = `Takeoff: ${t.symbols} symbols → ${t.lines.length} lines` + (t.unmatched ? ` (${t.unmatched} without a price book item)` : '');
    } else ui.toast('Drawing not found', 'error');
  } else if (query.fromPlanSet) {
    // a whole plan set: every sheet's symbols together (js/lib/plansets.js)
    const sheets = sortSheets(store.list('drawings', (d) => d.planSet?.id === query.fromPlanSet, { omit: ['underlay', 'strokes', 'texts', 'rooms', 'thumb'] }));
    if (sheets.length) {
      const t = takeoff(store, mergeForTakeoff(sheets));
      const setName = sheets[0].planSet.name || sheets[0].name;
      rec.lines = t.lines;
      rec.drawingId = sheets[0].id;
      rec.planSetId = query.fromPlanSet;
      const jobId = sheets.find((d) => d.jobId)?.jobId;
      const job = jobId && store.get('jobs', jobId);
      if (jobId) { rec.jobId = jobId; if (job) rec.clientId = rec.clientId || job.clientId || null; }
      rec.title = rec.title || `${job?.title || setName} — takeoff, ${sheets.length} sheets`;
      summary = `Takeoff from ${sheets.length} sheets: ${t.symbols} symbols → ${t.lines.length} lines` + (t.unmatched ? ` (${t.unmatched} without a price book item)` : '');
    } else ui.toast('Plan set not found', 'error');
  }
  const created = store.add('estimates', rec);
  if (summary) ui.toast(summary, 'success', 4000);
  location.replace('#/estimates/' + created.id);
}

/** Price-book items that drawing flags (set by the box placement checks) map to. */
const FLAG_ITEMS = {
  wp: (i) => (i.category || '').toLowerCase() === 'covers' && /in-use|weatherproof/i.test(i.name),
  afci: (i) => (i.category || '').toLowerCase() === 'breakers' && /afci/i.test(i.name) && !/gfci/i.test(i.name),
};

/**
 * Count drawing objects by symbol and map them onto price-book items. Flags on an
 * object add to the count: `flags.gfci` on a receptacle prices it as a GFCI
 * receptacle, `flags.wp` adds a weatherproof in-use cover, and `flags.afci` adds
 * an AFCI breaker per circuit (objects without a `circuit` count as one circuit).
 */
export function takeoff(store, drawing) {
  const counts = new Map();
  let wp = 0, afciObjects = 0;
  const afciCircuits = new Set();
  for (const o of drawing.objects || []) {
    if (!o.symbol) continue;
    const f = o.flags || {};
    const symbol = f.gfci && o.symbol === 'receptacle' ? 'receptacle-gfci' : o.symbol;
    counts.set(symbol, (counts.get(symbol) || 0) + 1);
    if (f.wp) wp++;
    if (f.afci) { afciObjects++; afciCircuits.add(o.circuit ?? '-'); }
  }
  const items = store.list('items');
  const lines = [];
  let unmatched = 0, symbols = 0;
  const push = (it, qty, fallback, note = '') => {
    if (it) lines.push({ itemId: it.id, description: it.name + note, qty, unitCents: it.priceCents, labourHours: it.labourHours || 0, kind: 'material' });
    else { unmatched++; lines.push({ itemId: null, description: `${fallback} (no price book item)${note}`, qty, unitCents: 0, labourHours: 0, kind: 'material' }); }
  };
  for (const [symbol, qty] of counts) {
    symbols += qty;
    push(items.find((i) => i.symbol === symbol), qty, symbol);
  }
  if (wp) push(items.find(FLAG_ITEMS.wp), wp, 'Weatherproof in-use cover');
  if (afciObjects) push(items.find(FLAG_ITEMS.afci), afciCircuits.size, 'AFCI breaker', ` (${afciObjects} AFCI outlets on the drawing: check the circuit count)`);
  return { lines, unmatched, symbols };
}

// ---------- detail / builder ----------
function renderDetail(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const est = store.get('estimates', id);
  if (!est) {
    root.append(ui.page({ title: 'Estimate not found' }, ui.empty({ icon: 'file-text', title: 'This estimate no longer exists', action: ui.button('All estimates', { href: '#/estimates' }) })));
    return;
  }
  const doc = est;
  const money = moneyFormatter(store.settings());
  const save = debounce(() => { store.update('estimates', id, pick(doc)); }, 450);
  // Invoicing or leads turned off (Settings → Modules): no buttons into them.
  const on = (m) => (ctx.on ? ctx.on(m) : moduleOn(store.settings(), m));
  const changed = () => { totals.update(doc); noTax.update(); save(); };
  // "Why no tax?" (QuickBooks contract 8.5): every company; each reason lands on its own GST return line.
  const noTax = noTaxReasonPicker(ctx, doc, { onChange: () => save() });

  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));

  const fieldEl = (f, onVal) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); changed(); });
    return el;
  };

  const header = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Title', name: 'title', value: doc.title, span: true }, (v) => { doc.title = v; }),
    fieldEl({ label: 'Client', name: 'clientId', type: 'select', value: doc.clientId || '', options: ui.recordOptions(clients) }, (v) => { doc.clientId = v || null; }),
    fieldEl({ label: 'Job', name: 'jobId', type: 'select', value: doc.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) }, (v) => { doc.jobId = v || null; }),
    fieldEl({ label: 'Valid until', name: 'validUntil', type: 'date', value: doc.validUntil }, (v) => { doc.validUntil = v; }),
    fieldEl({ label: 'Labour rate ($/h)', name: 'labourRateCents', type: 'money', value: doc.labourRateCents }, (v) => { doc.labourRateCents = v; }),
    fieldEl({ label: 'Materials markup %', name: 'markupPct', type: 'number', step: '0.1', min: '0', value: doc.markupPct ?? 0, hint: 'Extra uplift on material lines' }, (v) => { doc.markupPct = v || 0; }),
    taxEditor({ doc, store, onChange: changed }), noTax);

  const notes = fieldEl({ label: 'Notes shown on the estimate', name: 'notes', type: 'textarea', value: doc.notes, span: true }, (v) => { doc.notes = v; });
  const editor = lineEditor({ doc, store, onChange: changed });
  const totals = totalsPanel(doc, { money });

  const statusHost = h('div', { class: 'stack' });
  const drawStatus = () => {
    ui.clear(statusHost);
    const st = doc.status;
    h(statusHost, null,
      h('div', { class: 'row' }, h('strong', null, 'Status'), h('span', { class: 'grow' }), qboBadge(ctx, 'estimates', id, { detail: true, record: doc }), ui.statusBadge(st)),
      st === 'draft' ? lookupAction(ctx, { entity: 'estimates', clientId: doc.clientId }) : null,
      h('div', { class: 'row' },
        st !== 'sent' ? ui.button('Mark sent', { size: 'sm', icon: 'send', onClick: () => setStatus('sent') }) : null,
        st !== 'accepted' ? ui.button('Accepted', { size: 'sm', variant: 'primary', icon: 'check', onClick: () => accept() }) : null,
        st !== 'declined' ? ui.button('Declined', { size: 'sm', variant: 'ghost danger', icon: 'x', onClick: () => setStatus('declined') }) : null,
        st !== 'draft' ? ui.button('Back to draft', { size: 'sm', variant: 'ghost', onClick: () => setStatus('draft') }) : null),
      st === 'accepted' ? h('div', { class: 'row' },
        doc.jobId ? ui.button('Open job', { size: 'sm', icon: 'briefcase', href: '#/jobs/' + doc.jobId }) : ui.button('Create job', { size: 'sm', icon: 'briefcase', onClick: createJob }),
        on('invoices') ? ui.button('Create invoice', { size: 'sm', icon: 'receipt', onClick: () => { save.flush(); nav('#/invoices/new?estimateId=' + id); } }) : null) : null);
  };
  const setStatus = (st) => { doc.status = st; save.flush(); store.update('estimates', id, { status: st }, { summary: `${doc.number} → ${st}` }); drawStatus(); ui.toast(`${doc.number} marked ${st}`, 'success'); };
  const createJob = () => {
    save.flush();
    const job = store.add('jobs', {
      number: store.nextNumber('job'), title: doc.title || 'New job', clientId: doc.clientId || null,
      address: doc.clientId ? (store.get('clients', doc.clientId)?.address || '') : '', status: 'scheduled',
      startDate: '', endDate: '', crewIds: [], estimateId: id, description: doc.notes || '', changeOrders: [],
    });
    doc.jobId = job.id;
    store.update('estimates', id, { jobId: job.id });
    drawStatus();
    ui.toast(`Job ${job.number} created`, 'success');
    return job;
  };
  const accept = () => {
    setStatus('accepted');
    if (doc.leadId && on('leads')) { const l = store.get('leads', doc.leadId); if (l && l.stage !== 'won') store.update('leads', l.id, { stage: 'won' }); }
    const s = ui.openSheet({
      title: 'Estimate accepted', dialog: true,
      body: h('p', { style: { margin: 0 } }, `${doc.number} is accepted. What next?`),
      actions: [
        ui.button('Later', { variant: 'ghost', onClick: () => s.close() }),
        doc.jobId ? ui.button('Open job', { icon: 'briefcase', onClick: () => { s.close(); nav('#/jobs/' + doc.jobId); } })
          : ui.button('Create job', { icon: 'briefcase', onClick: () => { s.close(); createJob(); } }),
        on('invoices') ? ui.button('Create invoice', { variant: 'primary', icon: 'receipt', onClick: () => { s.close(); nav('#/invoices/new?estimateId=' + id); } }) : null,
      ].filter(Boolean),
    });
  };
  drawStatus();

  const duplicate = () => {
    save.flush();
    const copy = { ...pick(doc), number: store.nextNumber('estimate'), status: 'draft', title: `${doc.title || ''} (copy)`.trim(), validUntil: ui.today(30) };
    const c = store.add('estimates', copy);
    ui.toast(`Duplicated as ${c.number}`, 'success');
    nav('#/estimates/' + c.id);
  };
  const remove = async () => {
    if (!(await ui.confirmDialog(`Delete estimate ${doc.number}? This can't be undone.`, { okLabel: 'Delete' }))) return;
    save.flush();
    store.remove('estimates', id);
    ui.toast('Estimate deleted');
    nav('#/estimates');
  };

  const links = h('div', { class: 'row muted money-links' },
    doc.planSetId ? ui.button('Source plan set', { size: 'sm', variant: 'ghost', icon: 'layers', href: '#/drawings?set=' + encodeURIComponent(doc.planSetId) })
      : doc.drawingId ? ui.button('Source drawing', { size: 'sm', variant: 'ghost', icon: 'pen', href: '#/drawings/' + doc.drawingId }) : null,
    doc.leadId && on('leads') ? ui.button('Lead', { size: 'sm', variant: 'ghost', icon: 'funnel', href: '#/leads' }) : null);

  root.append(ui.page({
    title: `${doc.number}`,
    subtitle: h('span', null, ui.h('a', { href: '#/estimates' }, 'Estimates'), ' / ', doc.title || 'Untitled estimate'),
    actions: [
      ui.button('Print / PDF', { icon: 'printer', onClick: () => { save.flush(); previewDocument({ kind: 'Estimate', doc, store }); } }),
      ui.button('Duplicate', { icon: 'copy', onClick: duplicate }),
      ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete estimate', onClick: remove }),
    ],
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, header),
      h('div', { class: 'card' }, h('h3', null, 'Lines'), editor),
      h('div', { class: 'card' }, h('div', { class: 'form-grid' }, notes)),
      links),
    h('aside', { class: 'doc-side stack' },
      h('div', { class: 'card' }, statusHost),
      h('div', { class: 'card' }, h('h3', null, 'Totals'), totals)))));

  return () => save.flush();
}

function pick(d) {
  const { id, createdAt, updatedAt, ...rest } = d;
  void id; void createdAt; void updatedAt;
  return rest;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
