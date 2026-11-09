// Control panels (#/controlpanels): industrial / controls documentation for panel shops and PLC
// jobs. One record is a built control panel — header (tag, enclosure, voltage, SCCR, job), a
// components list that rolls up into a bill of materials (reusing the price book), an I/O list, a
// terminal/wiring schedule and a nameplate/engraving schedule — and prints as a shop package.
//   #/controlpanels          the list
//   #/controlpanels/new      a new panel
//   #/controlpanels/:id      edit one
// Pure logic: js/lib/controlpanels.js. Gated to the Fully Loaded (pro) plan (js/plans.js).
import {
  newPanel, newComponent, newIoPoint, newWire, newNameplate,
  componentCostCents, bomTotals, ioCounts, estimateLines, panelLabel,
  IO_TYPES, ENCLOSURE_TYPES, MAX_COMPONENTS, MAX_IO, MAX_WIRES, MAX_NAMEPLATES,
} from '../lib/controlpanels.js';
import { moneyFormatter } from '../lib/money.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/controlpanels.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/controlpanels.css';
  document.head.append(link);
}

export default {
  id: 'controlpanels',
  title: 'Control panels',
  icon: 'grid',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') {
      const job = ctx.query.jobId ? ctx.store.get('jobs', ctx.query.jobId) : null;
      const n = ctx.store.count('controlPanels', (p) => (job ? p.jobId === job.id : true)) + 1;
      const rec = ctx.store.add('controlPanels', newPanel({ name: `Panel ${n}`, job, by: ctx.store.actorId }));
      ctx.nav(`#/controlpanels/${rec.id}`);
      return;
    }
    if (sub) return detail(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? `${j.number || ''}${j.number ? ' · ' : ''}${j.title || 'Job'}`.trim() : '—');

// ---------- list ----------
function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const all = store.list('controlPanels').sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    host.append(all.length ? ui.table({
      columns: [
        { key: 'tag', label: 'Tag / name', render: (p) => panelLabel(p), sort: (p) => panelLabel(p).toLowerCase() },
        { key: 'job', label: 'Job', render: (p) => jobLabel(jobs.get(p.jobId)) },
        { key: 'encl', label: 'Enclosure', render: (p) => p.enclosureType || '—' },
        { key: 'io', label: 'I/O', align: 'right', render: (p) => ioCounts(p).total || 0 },
        { key: 'bom', label: 'BOM', align: 'right', render: (p) => money(bomTotals(p).materialCents) },
        { key: 'updated', label: 'Updated', render: (p) => ui.fmtDate(p.updatedAt || p.createdAt), sort: (p) => p.updatedAt || p.createdAt || '' },
      ],
      rows: all, onRowClick: (p) => nav(`controlpanels/${p.id}`),
    }) : ui.empty({
      icon: 'grid', title: 'No control panels yet',
      text: 'Document a built control panel: enclosure and ratings, a components bill of materials, the I/O list, a wiring schedule and the nameplate engraving schedule — then print the shop package.',
      action: ui.button('New panel', { variant: 'primary', icon: 'plus', href: '#/controlpanels/new' }),
    }));
  };
  root.append(ui.page({
    title: 'Control panels',
    subtitle: 'Panel builds for industrial and controls work: BOM, I/O, wiring and nameplate schedules',
    actions: [ui.button('New panel', { variant: 'primary', icon: 'plus', href: '#/controlpanels/new' })],
  }, host));
  draw();
  return store.on('controlPanels', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

// ---------- detail ----------
function detail(root, ctx, id) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const p = store.get('controlPanels', id);
  if (!p) { ui.toast('That panel is gone.', 'error'); nav('#/controlpanels'); return; }
  p.components = p.components || [];
  p.io = p.io || [];
  p.wiring = p.wiring || [];
  p.nameplates = p.nameplates || [];
  const money = moneyFormatter(store.settings());
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const items = store.list('items').sort((x, y) => String(x.name).localeCompare(String(y.name)));

  const save = (patch) => store.update('controlPanels', id, patch);
  const header = () => ({
    name: p.name, tag: p.tag, enclosureType: p.enclosureType, enclosureRating: p.enclosureRating,
    systemVoltage: p.systemVoltage, sccr: p.sccr, jobId: p.jobId, clientId: p.clientId, notes: p.notes,
  });
  const saveHeader = () => save(header());
  const debounced = (fn, key, ms = 450) => { clearTimeout(debounced[key]); debounced[key] = setTimeout(fn, ms); };

  // ----- header -----
  const fieldEl = (f, onVal, delay = 450) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => {
      onVal(ui.readForm(el)[f.name]);
      if (delay === 0) saveHeader(); else debounced(saveHeader, f.name, delay);
    });
    return el;
  };
  const enclosureOpts = [{ value: '', label: '—' }, ...ENCLOSURE_TYPES.map((t) => ({ value: t, label: t }))];
  const headGrid = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Panel name', name: 'name', value: p.name, placeholder: 'Main PLC panel' }, (v) => { p.name = v; titleEl.textContent = panelLabel(p); }),
    fieldEl({ label: 'Tag', name: 'tag', value: p.tag, placeholder: 'CP-101' }, (v) => { p.tag = v; titleEl.textContent = panelLabel(p); }),
    fieldEl({ label: 'Job', name: 'jobId', type: 'select', value: p.jobId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`)] }, (v) => { p.jobId = v || null; const j = v && store.get('jobs', v); if (j) p.clientId = j.clientId || p.clientId; }, 0),
    fieldEl({ label: 'Enclosure type', name: 'enclosureType', type: 'select', value: p.enclosureType || '', options: enclosureOpts }, (v) => { p.enclosureType = v; }, 0),
    fieldEl({ label: 'Enclosure rating / size', name: 'enclosureRating', value: p.enclosureRating, placeholder: 'e.g. 36x30x12, painted steel' }, (v) => { p.enclosureRating = v; }),
    fieldEl({ label: 'System voltage', name: 'systemVoltage', value: p.systemVoltage, placeholder: 'e.g. 600V 3PH 4W' }, (v) => { p.systemVoltage = v; }),
    fieldEl({ label: 'SCCR', name: 'sccr', value: p.sccr, placeholder: 'e.g. 65 kA', hint: 'Short-circuit current rating' }, (v) => { p.sccr = v; }),
    fieldEl({ label: 'Notes', name: 'notes', type: 'textarea', value: p.notes, span: true }, (v) => { p.notes = v; }, 600));

  // ----- a generic schedule table (rows of fields with add/remove) -----
  function schedule({ rows, cols, make, max, saveKey, addLabel }) {
    const rowsHost = h('div', { class: 'cp-rows' });
    const headRow = h('div', { class: 'cp-rowhead muted', style: gridStyle(cols) }, cols.map((c) => h('span', { class: c.num ? 'num' : null }, c.label)), h('span', null, ''));
    const persist = () => debounced(() => save({ [saveKey]: rows }), saveKey, 400);
    const drawRows = () => {
      ui.clear(rowsHost);
      rowsHost.append(headRow);
      rows.forEach((r, i) => {
        const cells = cols.map((col) => {
          if (col.type === 'select') {
            const sel = h('select', { class: 'input', 'aria-label': col.label }, col.options.map((o) => h('option', { value: o.value, selected: (r[col.key] || col.options[0]?.value) === o.value }, o.label)));
            sel.addEventListener('change', () => { r[col.key] = sel.value; persist(); if (col.redraw) drawRows(); });
            return sel;
          }
          const inp = h('input', {
            class: col.num ? 'input num' : 'input', value: r[col.key] ?? '', placeholder: col.placeholder || '',
            type: col.num ? 'number' : 'text', inputmode: col.num ? 'decimal' : undefined, step: col.step, min: col.num ? '0' : undefined, 'aria-label': col.label,
          });
          inp.addEventListener('input', () => { r[col.key] = col.num ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value.slice(0, col.max || 200); persist(); if (col.live) col.live(); });
          return inp;
        });
        const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove', onClick: () => { rows.splice(i, 1); save({ [saveKey]: rows }); drawRows(); } });
        rowsHost.append(h('div', { class: 'cp-row', style: gridStyle(cols) }, cells, rm));
      });
      if (rows.length < max) rowsHost.append(h('button', { type: 'button', class: 'cp-addrow', onClick: () => { rows.push(make()); save({ [saveKey]: rows }); drawRows(); } }, ui.icon('plus', 16), addLabel));
    };
    drawRows();
    return { el: rowsHost, drawRows };
  }
  const gridStyle = (cols) => ({ 'grid-template-columns': `${cols.map((c) => c.w || '1fr').join(' ')} auto` });

  // ----- components / BOM -----
  const bomStat = h('div', { class: 'cp-bomstat' });
  const drawBom = () => {
    const t = bomTotals(p);
    const c = ioCounts(p);
    ui.clear(bomStat).append(
      ui.stat({ label: 'BOM lines', value: String(t.lineCount) }),
      ui.stat({ label: 'Pieces', value: String(t.totalQty) }),
      ui.stat({ label: 'Material (cost)', value: money(t.materialCents), tone: 'accent' }),
      ui.stat({ label: 'I/O points', value: String(c.total), hint: `${c.DI} DI · ${c.DO} DO · ${c.AI} AI · ${c.AO} AO` }));
  };
  const bomRowsHost = h('div', { class: 'cp-rows' });
  const drawBomRows = () => {
    ui.clear(bomRowsHost);
    bomRowsHost.append(h('div', { class: 'cp-rowhead muted cp-bom-grid' },
      h('span', null, 'Item'), h('span', null, 'Part #'), h('span', null, 'Description'), h('span', null, 'Mfr'), h('span', { class: 'num' }, 'Qty'), h('span', { class: 'num' }, 'Unit $'), h('span', { class: 'num' }, 'Ext'), h('span', null, '')));
    p.components.forEach((c, i) => bomRowsHost.append(bomRow(c, i)));
    if (p.components.length < MAX_COMPONENTS) bomRowsHost.append(h('button', { type: 'button', class: 'cp-addrow', onClick: () => { p.components.push(newComponent()); save({ components: p.components }); drawBomRows(); drawBom(); } }, ui.icon('plus', 16), 'Add component'));
  };
  function bomRow(c, i) {
    const ext = h('span', { class: 'num cp-ext' }, money(componentCostCents(c)));
    const pick = h('select', { class: 'input', 'aria-label': 'Price-book item' },
      h('option', { value: '' }, 'Custom'),
      items.map((it) => h('option', { value: it.id, selected: it.id === c.itemId }, `${it.name}${it.sku ? ` (${it.sku})` : ''}`)));
    pick.addEventListener('change', () => {
      const it = store.get('items', pick.value);
      if (it) { c.itemId = it.id; c.part = it.sku || ''; c.description = it.name; c.manufacturer = it.manufacturer || c.manufacturer; c.unitCents = it.costCents ?? it.priceCents ?? 0; }
      else { c.itemId = null; }
      save({ components: p.components }); drawBomRows(); drawBom();
    });
    const textCell = (key, ph, max = 300) => {
      const inp = h('input', { class: 'input', value: c[key] ?? '', placeholder: ph, 'aria-label': ph });
      inp.addEventListener('input', () => { c[key] = inp.value.slice(0, max); debounced(() => save({ components: p.components }), `bom${i}${key}`, 500); });
      return inp;
    };
    const qty = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: '1', min: '0', value: c.qty ?? 1, 'aria-label': 'Quantity' });
    qty.addEventListener('input', () => { c.qty = qty.value === '' ? 0 : Number(qty.value); ext.textContent = money(componentCostCents(c)); debounced(() => { save({ components: p.components }); drawBom(); }, `bom${i}qty`, 400); });
    const cost = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: c.unitCents == null ? '' : (c.unitCents / 100), 'aria-label': 'Unit cost' });
    cost.addEventListener('input', () => { c.unitCents = cost.value === '' ? 0 : Math.round(Number(cost.value) * 100); ext.textContent = money(componentCostCents(c)); debounced(() => { save({ components: p.components }); drawBom(); }, `bom${i}cost`, 400); });
    const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove', onClick: () => { p.components.splice(i, 1); save({ components: p.components }); drawBomRows(); drawBom(); } });
    return h('div', { class: 'cp-row cp-bom-grid' }, pick, textCell('part', 'Part #', 200), textCell('description', 'Description'), textCell('manufacturer', 'Mfr', 200), qty, cost, ext, rm);
  }

  // ----- I/O list -----
  const ioTable = schedule({
    rows: p.io, saveKey: 'io', make: () => newIoPoint('DI'), max: MAX_IO, addLabel: 'Add I/O point',
    cols: [
      { key: 'tag', label: 'Tag', placeholder: 'PMP-01', w: '1fr', max: 80 },
      { key: 'type', label: 'Type', type: 'select', options: IO_TYPES.map((t) => ({ value: t.id, label: t.id })), w: '80px' },
      { key: 'description', label: 'Description', placeholder: 'Pump run feedback', w: '2fr' },
      { key: 'device', label: 'Device', placeholder: 'Aux contact', w: '1.3fr', max: 200 },
      { key: 'terminal', label: 'Terminal', placeholder: 'X1:4', w: '0.9fr', max: 80 },
      { key: 'address', label: 'PLC address', placeholder: 'I0.3', w: '1fr', max: 80, live: () => drawBom() },
    ],
  });

  // ----- wiring schedule -----
  const wireTable = schedule({
    rows: p.wiring, saveKey: 'wiring', make: newWire, max: MAX_WIRES, addLabel: 'Add wire',
    cols: [
      { key: 'wire', label: 'Wire #', placeholder: '101', w: '0.8fr', max: 80 },
      { key: 'from', label: 'From', placeholder: 'CB1:2', w: '1.3fr', max: 200 },
      { key: 'to', label: 'To', placeholder: 'TB1:5', w: '1.3fr', max: 200 },
      { key: 'gauge', label: 'Gauge', placeholder: '16 AWG', w: '0.9fr', max: 40 },
      { key: 'colour', label: 'Colour', placeholder: 'Red', w: '0.9fr', max: 40 },
      { key: 'terminal', label: 'Terminal', placeholder: 'Ferrule', w: '0.9fr', max: 80 },
    ],
  });

  // ----- nameplate / engraving schedule -----
  const nameTable = schedule({
    rows: p.nameplates, saveKey: 'nameplates', make: newNameplate, max: MAX_NAMEPLATES, addLabel: 'Add nameplate',
    cols: [
      { key: 'item', label: 'Item', placeholder: 'Main disconnect', w: '1.4fr', max: 200 },
      { key: 'legend', label: 'Legend / engraving text', placeholder: 'MAIN 600V', w: '2fr' },
      { key: 'size', label: 'Size', placeholder: '1" x 3"', w: '0.9fr', max: 40 },
      { key: 'colour', label: 'Colour', placeholder: 'White / black', w: '1.1fr', max: 40 },
    ],
  });

  // ----- actions -----
  const remove = async () => {
    if (!(await ui.confirmDialog(`Delete the control panel "${panelLabel(p)}"? Its BOM, I/O and schedules go too.`, { okLabel: 'Delete' }))) return;
    store.remove('controlPanels', id); ui.toast('Panel deleted'); nav('#/controlpanels');
  };
  const print = () => printPanel(ui, p, { store, job: p.jobId ? store.get('jobs', p.jobId) : null, money });

  function addToEstimate() {
    const lines = estimateLines(p);
    if (!lines.length) { ui.toast('Add priced components first', 'error'); return; }
    const j = p.jobId ? store.get('jobs', p.jobId) : null;
    const drafts = store.list('estimates', (e) => e.status === 'draft' && (j ? e.jobId === j.id : true)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    let target = drafts[0]?.id || '__new';
    const body = h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `${lines.length} priced component line${lines.length === 1 ? '' : 's'} will be added, at cost. Price them on the estimate.`),
      ui.field({ label: 'Estimate', name: 'est', type: 'select', value: target, options: [...drafts.map((e) => ({ value: e.id, label: `${e.number} · ${e.title || 'Untitled'} (draft)` })), { value: '__new', label: 'New draft estimate' }] }));
    const sel = body.querySelector('[name="est"]');
    sel.addEventListener('change', () => { target = sel.value; });
    const sheet = ui.openSheet({
      title: 'Add BOM to estimate', body,
      actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Add lines', { variant: 'primary', icon: 'plus', onClick: () => {
        const estLines = lines.map((l) => ({ itemId: l.itemId, description: l.description, qty: l.qty, unitCents: l.unitCents }));
        let est;
        if (target === '__new') {
          est = store.add('estimates', { number: store.nextNumber('estimate'), title: `Panel ${panelLabel(p)}`, status: 'draft', jobId: j?.id || null, clientId: p.clientId || j?.clientId || null, lines: estLines });
        } else {
          const e = store.get('estimates', target);
          if (!e) { ui.toast('That estimate no longer exists', 'error'); return; }
          est = store.update('estimates', e.id, { lines: [...(e.lines || []), ...estLines] }, { summary: `${e.number}: panel ${panelLabel(p)}` });
        }
        sheet.close();
        ui.toast(`Added ${estLines.length} line${estLines.length === 1 ? '' : 's'} to ${est.number}`, 'success');
        nav('#/estimates/' + est.id);
      } })],
    });
  }

  const page = ui.page({
    title: panelLabel(p),
    subtitle: h('span', null, ui.h('a', { href: '#/controlpanels' }, 'Control panels'), ' / ', panelLabel(p)),
    actions: [
      ui.button('Print package', { icon: 'printer', variant: 'primary', onClick: print }),
      auth.can('estimates') ? ui.button('Add to estimate', { icon: 'file-text', onClick: addToEstimate }) : null,
      ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete panel', onClick: remove }),
    ],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Panel'), headGrid),
      h('section', { class: 'card' }, h('h3', null, 'Summary'), bomStat),
      h('section', { class: 'card' },
        h('h3', null, 'Components (bill of materials)'),
        h('p', { class: 'muted cp-hint' }, 'Pick price-book items or type custom parts. Enter material cost per unit; the extended cost rolls up into the BOM total.'),
        bomRowsHost),
      h('section', { class: 'card' },
        h('h3', null, 'I/O list'),
        h('p', { class: 'muted cp-hint' }, 'Field I/O to the PLC: tag, type (DI/DO/AI/AO), the device, the panel terminal and the PLC address.'),
        ioTable.el),
      h('section', { class: 'card' }, h('h3', null, 'Terminal / wiring schedule'), wireTable.el),
      h('section', { class: 'card' }, h('h3', null, 'Nameplate / engraving schedule'), nameTable.el),
      h('div', { class: 'row' }, ui.button('Back to control panels', { variant: 'ghost', href: '#/controlpanels' }))));
  root.append(page);
  const titleEl = page.querySelector('.page-head h1');

  drawBom();
  drawBomRows();
}

// ---------- print ----------
function printPanel(ui, p, { store, job, money }) {
  const { h } = ui;
  const co = store.settings().company || {};
  const client = p.clientId ? store.get('clients', p.clientId) : (job?.clientId ? store.get('clients', job.clientId) : null);
  const t = bomTotals(p);
  const c = ioCounts(p);
  const table = (heads, bodyRows, foot) => h('table', null,
    h('thead', null, h('tr', null, heads.map((x) => h('th', { class: x.right ? 'right' : null }, x.label || x)))),
    h('tbody', null, bodyRows),
    foot || null);
  const td = (cells) => h('tr', null, cells.map((x) => h('td', { class: x && x.right ? 'right' : null }, x && x.right ? x.v : x)));

  const node = h('div', { class: 'cp-print' }, h('article', { class: 'cp-doc' },
    h('header', { class: 'cp-doc-top' },
      h('div', null, h('div', { class: 'cp-doc-brand' }, co.name || 'Company'), h('div', { class: 'cp-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'cp-doc-right' }, h('div', { class: 'cp-doc-kind' }, 'Control panel package'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, panelLabel(p)),
    h('table', { class: 'cp-doc-meta' }, h('tbody', null,
      metaRow('Job', jobLabel(job)), metaRow('Client', client?.name || '—'),
      metaRow('Enclosure', [p.enclosureType, p.enclosureRating].filter(Boolean).join(' · ') || '—'),
      metaRow('System voltage', p.systemVoltage || '—'), metaRow('SCCR', p.sccr || '—'),
      metaRow('I/O points', `${c.total} (${c.DI} DI · ${c.DO} DO · ${c.AI} AI · ${c.AO} AO)`))),

    h('h2', null, 'Bill of materials'),
    table(['#', 'Part #', 'Description', 'Mfr', { label: 'Qty', right: true }, { label: 'Unit', right: true }, { label: 'Ext', right: true }],
      p.components.map((x, i) => h('tr', null,
        h('td', null, i + 1), h('td', null, x.part || '—'), h('td', null, x.description || '—'), h('td', null, x.manufacturer || '—'),
        h('td', { class: 'right' }, x.qty ?? 0), h('td', { class: 'right' }, money(x.unitCents || 0)), h('td', { class: 'right' }, money(componentCostCents(x))))),
      h('tfoot', null, h('tr', { class: 'strong' }, h('td', { colspan: '4' }, `Total material (cost) — ${t.lineCount} lines, ${t.totalQty} pieces`), h('td'), h('td'), h('td', { class: 'right' }, money(t.materialCents))))),

    h('h2', null, 'I/O list'),
    table(['Tag', 'Type', 'Description', 'Device', 'Terminal', 'PLC address'],
      p.io.map((x) => td([x.tag || '—', x.type || '—', x.description || '—', x.device || '—', x.terminal || '—', x.address || '—']))),

    h('h2', null, 'Terminal / wiring schedule'),
    table(['Wire #', 'From', 'To', 'Gauge', 'Colour', 'Terminal'],
      p.wiring.map((x) => td([x.wire || '—', x.from || '—', x.to || '—', x.gauge || '—', x.colour || '—', x.terminal || '—']))),

    h('h2', null, 'Nameplate / engraving schedule'),
    table(['Item', 'Legend text', 'Size', 'Colour'],
      p.nameplates.map((x) => td([x.item || '—', x.legend || '—', x.size || '—', x.colour || '—']))),

    p.notes ? [h('h2', null, 'Notes'), h('p', { class: 'cp-doc-notes' }, p.notes)] : null));

  document.body.append(node);
  document.body.classList.add('cp-printing');
  const done = () => { node.remove(); document.body.classList.remove('cp-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);

  function metaRow(k, v) { return h('tr', null, h('th', null, k), h('td', null, v)); }
}
