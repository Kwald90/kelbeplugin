// Estimates (S17): list, builder with price-book line editor, takeoff from drawings, print.
import { docTotals, moneyFormatter } from '../lib/money.js';
import { newDocTax } from '../lib/tax.js';
import { mergeForTakeoff, sortSheets } from '../lib/plansets.js';
import { lineEditor, taxEditor, totalsPanel, previewDocument, clientName } from '../lib/doc-view.js';
import { moduleOn } from '../lib/modules.js';
import { qboBadge, noTaxReasonPicker, lookupAction, docEditor } from '../lib/qbo-ui.js';

const STATUSES = ['draft', 'sent', 'accepted', 'declined'];

export default {
  id: 'estimates',
  title: 'Estimates',
  icon: 'file-text',
  group: 'money',
  perm: 'estimates',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (sub === 'new') {
      if (ctx.readOnly) {
        root.append(ctx.ui.page({ title: 'Estimates are view only' }, ctx.ui.empty({ icon: 'lock', title: 'Creating estimates requires a plan with Estimates', text: 'Your existing estimates are available to view.', action: ctx.ui.button('All estimates', { href: '#/estimates' }) })));
        return;
      }
      return createNew(ctx);
    }
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
          { key: 'status', label: 'Status', render: (e) => h('span', { class: 'row-inline' }, ui.statusBadge(e.status), ctx.readOnly ? null : qboBadge(ctx, 'estimates', e.id, { record: e })), sort: (e) => e.status },
          { key: 'validUntil', label: 'Valid until', render: (e) => validCell(ui, e), sort: (e) => e.validUntil || '' },
        ],
        rows: r,
        onRowClick: (e) => nav('#/estimates/' + e.id),
        empty: ui.empty({ icon: 'file-text', title: all.length ? 'No estimates match' : 'No estimates yet',
          text: all.length ? 'Try another tab or search.' : 'Build a quote from the price book, or run a takeoff from a drawing.',
          action: all.length || ctx.readOnly ? null : ui.button('New estimate', { variant: 'primary', icon: 'plus', href: '#/estimates/new' }) }),
      }));
    }
  };
  const tableHost = h('div');

  root.append(ui.page({
    title: 'Estimates', subtitle: 'Quotes built from the price book and drawing takeoffs',
    actions: ctx.readOnly ? [] : [ui.button('New estimate', { variant: 'primary', icon: 'plus', href: '#/estimates/new' })],
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
  const readOnly = Boolean(ctx.readOnly);
  const money = moneyFormatter(store.settings());
  // Saves only the fields changed here (never status, which its buttons write), and takes in what
  // QuickBooks or another device changed while the estimate is open (QuickBooks contract 5.10).
  const save = docEditor(store, 'estimates', id, doc, {
    write: (patch, opts) => readOnly ? store.get('estimates', id) : store.update('estimates', id, patch, opts),
    onPulled: (fields, clashes) => {
      if (clashes.length) ui.toast(`${doc.number} changed in QuickBooks or on another device while you were editing it. The latest version is shown; check your last change.`, 'info', 7000);
      if (fields.some((f) => FORM_FIELDS.includes(f))) { redraw(); return; }
      drawStatus();
    },
    onRemoved: () => { ui.toast(`${doc.number} was deleted on another device`, 'info', 4000); nav('#/estimates'); },
  });
  // Re-open the screen on the record as it now is, where it was scrolled to.
  const redraw = () => {
    if (typeof ctx.route !== 'function') { drawStatus(); return; }
    const top = root.scrollTop;
    ctx.route();
    root.scrollTop = top;
  };
  // Invoicing or leads turned off (Settings → Modules): no buttons into them.
  const on = (m) => (ctx.on ? ctx.on(m) : moduleOn(store.settings(), m));
  const changed = () => { totals.update(doc); noTax.update(); save(); };
  // "Why no tax?" (QuickBooks contract 8.5): every company; each reason lands on its own GST return line.
  const noTax = noTaxReasonPicker(ctx, doc, { onChange: () => save(), readOnly });

  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));

  const fieldEl = (f, onVal) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.disabled = readOnly;
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); changed(); });
    return el;
  };

  const header = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Customer', name: 'clientId', type: 'select', value: doc.clientId || '', options: ui.recordOptions(clients) }, (v) => { doc.clientId = v || null; }),
    fieldEl({ label: 'Valid until', name: 'validUntil', type: 'date', value: doc.validUntil }, (v) => { doc.validUntil = v; }),
    fieldEl({ label: 'Work to be quoted', name: 'title', value: doc.title, span: true, placeholder: 'For example: panel replacement at the shop' }, (v) => { doc.title = v; }),
    fieldEl({ label: 'Linked job (optional)', name: 'jobId', type: 'select', value: doc.jobId || '', span: true, options: ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`) }, (v) => { doc.jobId = v || null; drawStatus(); }));

  const pricing = h('details', { class: 'card estimate-pricing' },
    h('summary', null, 'Pricing & tax settings'),
    h('p', { class: 'muted estimate-hint' }, 'Review labour rates, material markup and tax treatment for this work.'),
    h('div', { class: 'form-grid' },
      fieldEl({ label: 'Labour rate ($/h)', name: 'labourRateCents', type: 'money', value: doc.labourRateCents }, (v) => { doc.labourRateCents = v; }),
      fieldEl({ label: 'Materials markup %', name: 'markupPct', type: 'number', step: '0.1', min: '0', value: doc.markupPct ?? 0, hint: 'Extra uplift on material lines' }, (v) => { doc.markupPct = v || 0; }),
      taxEditor({ doc, store, onChange: changed, readOnly })));

  const notes = fieldEl({ label: 'Notes shown on the estimate', name: 'notes', type: 'textarea', value: doc.notes, span: true }, (v) => { doc.notes = v; });
  const editor = lineEditor({ doc, store, onChange: changed, readOnly });
  const totals = totalsPanel(doc, { money });

  const preview = () => { save.flush(); previewDocument({ kind: 'Estimate', doc, store, readOnly }); };
  const linkedJob = () => {
    const latest = store.get('estimates', id);
    return (latest?.jobId && store.get('jobs', latest.jobId)) || (doc.jobId && store.get('jobs', doc.jobId)) || store.list('jobs').find((j) => j.estimateId === id);
  };
  const jobHref = (job) => '#/jobs/' + job.id + (on('schedule') ? '?tab=schedule' : '');
  const statusHost = h('section', { class: 'card estimate-next', 'aria-label': 'Quote next step' });
  const drawStatus = () => {
    ui.clear(statusHost);
    const st = doc.status;
    const job = linkedJob();
    const next = readOnly ? ['View quote', 'This estimate is available to view. Editing requires a plan with Estimates.']
      : st === 'accepted' ? [job ? 'Plan the work' : 'Turn approval into a job', 'Open the job to choose dates and assign the crew.']
      : st === 'sent' ? ['Awaiting the customer', 'When the customer approves by email, phone or in person, record that approval here.']
      : st === 'declined' ? ['Review the feedback', 'Return to draft to revise the scope and price before sending again.']
      : ['Review before sending', 'Preview the customer quote, then print it or email it when an email integration is connected.'];
    const primary = readOnly ? ui.button('Preview quote', { variant: 'primary', icon: 'file-text', onClick: preview })
      : st === 'accepted' ? ui.button(job ? 'Open job' : 'Create job', { variant: 'primary', icon: 'briefcase', onClick: createJob })
      : st === 'sent' ? ui.button('Record approval', { variant: 'primary', icon: 'check', onClick: accept })
      : st === 'declined' ? ui.button('Return to draft', { variant: 'primary', onClick: () => setStatus('draft') })
      : ui.button('Preview quote', { variant: 'primary', icon: 'file-text', onClick: preview });
    h(statusHost, null,
      h('div', { class: 'estimate-next-copy' },
        h('div', { class: 'row' }, h('h2', null, next[0]), ui.statusBadge(st), !readOnly ? qboBadge(ctx, 'estimates', id, { detail: true, record: doc }) : null),
        h('p', { class: 'muted estimate-hint' }, next[1])),
      h('div', { class: 'row estimate-next-actions' }, primary,
        !readOnly && st === 'accepted' && on('invoices') ? ui.button('Create invoice', { icon: 'receipt', onClick: () => { save.flush(); nav('#/invoices/new?estimateId=' + id); } }) : null),
      !readOnly ? h('details', { class: 'estimate-status-actions' },
        h('summary', null, 'Update status'),
        h('p', { class: 'muted estimate-hint' }, 'These actions record what happened outside Fishtape. Mark sent does not send an email.'),
        h('div', { class: 'row' },
          st !== 'sent' ? ui.button('Mark sent', { size: 'sm', icon: 'send', onClick: () => setStatus('sent') }) : null,
          st !== 'accepted' ? ui.button('Record approval', { size: 'sm', icon: 'check', onClick: accept }) : null,
          st !== 'declined' ? ui.button('Record decline', { size: 'sm', variant: 'ghost danger', icon: 'x', onClick: () => setStatus('declined') }) : null,
          st !== 'draft' ? ui.button('Back to draft', { size: 'sm', variant: 'ghost', onClick: () => setStatus('draft') }) : null,
          st === 'draft' ? lookupAction(ctx, { entity: 'estimates', clientId: doc.clientId }) : null)) : null);
  };
  const setStatus = (st) => {
    if (readOnly) return;
    save.write({ status: st }, { summary: `${doc.number} -> ${st}` });
    drawStatus();
    ui.toast(st === 'accepted' ? `Approval recorded for ${doc.number}` : `${doc.number} marked ${st}`, 'success');
  };
  const createJob = () => {
    if (readOnly) return;
    save.flush();
    // Reuse the linked job or an existing conversion, including a link received from sync.
    // Cross-device uniqueness still belongs to the server; this prevents repeat local creation.
    const existing = linkedJob();
    if (existing) { nav(jobHref(existing)); return existing; }
    const job = store.add('jobs', {
      number: store.nextNumber('job'), title: doc.title || 'New job', clientId: doc.clientId || null,
      address: doc.clientId ? (store.get('clients', doc.clientId)?.address || '') : '', status: 'scheduled',
      startDate: '', endDate: '', crewIds: [], estimateId: id, description: doc.notes || '', changeOrders: [],
    });
    save.write({ jobId: job.id });
    ui.toast(`Job ${job.number} created. Choose dates and assign the crew.`, 'success');
    nav(jobHref(job));
    return job;
  };
  const accept = () => {
    if (readOnly) return;
    const s = ui.openSheet({
      title: 'Record customer approval', dialog: true,
      body: h('p', { class: 'estimate-hint' }, `Record approval for ${doc.number} only after receiving it from the customer by email, phone or in person. This updates the estimate status; it does not capture a customer signature. Keep the original approval with your job records.`),
      actions: [
        ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Record approval', { variant: 'primary', icon: 'check', onClick: () => {
          setStatus('accepted');
          if (doc.leadId && on('leads')) { const l = store.get('leads', doc.leadId); if (l && l.stage !== 'won') store.update('leads', l.id, { stage: 'won' }); }
          s.close();
        } }),
      ],
    });
  };
  drawStatus();

  const duplicate = () => {
    if (readOnly) return;
    save.flush();
    const copy = { ...pick(doc), number: store.nextNumber('estimate'), status: 'draft', title: `${doc.title || ''} (copy)`.trim(), validUntil: ui.today(30) };
    const c = store.add('estimates', copy);
    ui.toast(`Duplicated as ${c.number}`, 'success');
    nav('#/estimates/' + c.id);
  };
  const remove = async () => {
    if (readOnly) return;
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
      ui.button('Preview quote', { icon: 'file-text', onClick: preview }),
      !readOnly ? ui.button('Duplicate', { icon: 'copy', onClick: duplicate }) : null,
      !readOnly ? ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete estimate', onClick: remove }) : null,
    ],
  },
  h('div', { class: 'estimate-experience stack' },
    statusHost,
    h('div', { class: 'doc-layout' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h3', null, 'Customer & work'), header),
        h('section', { class: 'card' }, h('h3', null, 'Scope & line items'), editor),
        h('section', { class: 'card' }, h('h3', null, 'Customer notes'), h('div', { class: 'form-grid' }, notes)),
        pricing,
        links),
      h('aside', { class: 'doc-side stack', 'aria-label': 'Quote totals' },
        h('div', { class: 'card' }, h('h3', null, 'Quote total'), totals,
          h('div', { class: 'form-grid estimate-tax-reason' }, noTax)))))));


  return () => save.stop();
}

/** Estimate fields the detail screen shows in its form: changed elsewhere, the screen is drawn again. */
const FORM_FIELDS = ['number', 'title', 'clientId', 'jobId', 'validUntil', 'labourRateCents', 'markupPct', 'taxes', 'taxPct', 'taxProvince', 'taxTreatment', 'taxNoneReason', 'notes', 'lines'];

function pick(d) {
  const { id, createdAt, updatedAt, ...rest } = d;
  void id; void createdAt; void updatedAt;
  return rest;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
