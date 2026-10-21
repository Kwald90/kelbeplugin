// Inventory (S19): price book, stock by location, stock moves, locations.
// Release 1 (docs/releases/r1-get-paid.md 3.5, 8.4; docs/office/month-end.md): moves onto a job can be
// tagged own use (warranty, no charge, shop, truck, tools), the default for warranty, callback and
// unbilled jobs; "Receive" records deliveries against purchase orders (server receiving route, which
// keeps the moving average); count sheets (#/inventory/counts) are counted on a phone and posted as
// adjustments against the quantity when counted; valuation (#/inventory/valuation) values each
// location as of a day. Moves in a closed period are reversed, never undone.
import { SYMBOL_IDS } from '../seed.js';
import { store as appStore } from '../store.js';
import { switchOn } from '../lib/modules.js';
import { reopenAfterUndo } from '../lib/materials.js';
import { ownUseJob, OWN_USE_REASONS, OWN_USE_REASON_LABEL } from '../lib/rst.js';
import { countSheet, countAdjustments, countProblems, countProgress, valuationByLocation, COUNT_STATUS_LABEL } from '../lib/stock-counts.js';
import { isLocked, locksFrom, zoneFor, REVERSAL_ACTION } from '../lib/closing.js';
import { receiveSheet } from './purchasing.js';

/** Stock (shop, vans, moves) can be turned off while the price book stays (Settings → Modules). */
const stockOn = (store) => switchOn(store.settings(), 'inventory');

const TABS = [
  { id: 'book', label: 'Price book' }, { id: 'stock', label: 'Stock' },
  { id: 'moves', label: 'Moves' }, { id: 'locations', label: 'Locations' },
  { id: 'counts', label: 'Counts' }, { id: 'valuation', label: 'Valuation' },
];

/** The module's count-sheet styles live with job costing (css/reports.css). */
function ensureCountStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/reports.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/reports.css';
  document.head.append(link);
}
const MOVE_TYPES = [
  { value: 'transfer', label: 'Transfer between locations' },
  { value: 'receive', label: 'Receive into a location' },
  { value: 'use', label: 'Use on a job' },
];

export const itemTotal = (it) => Object.values(it.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);
export const isLow = (it) => Number(it.reorderPoint) > 0 && itemTotal(it) < Number(it.reorderPoint);

export default {
  id: 'inventory',
  get title() { return stockOn(appStore) ? 'Inventory' : 'Price book'; },
  icon: 'box',
  group: 'money',
  perm: 'inventory',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    ensureCountStyles();
    const seesMoney = auth.seesMoney?.() ?? true;
    const tabs = stockOn(store) ? TABS.filter((t) => t.id !== 'valuation' || seesMoney) : TABS.filter((t) => t.id === 'book');
    let tab = tabs.some((t) => t.id === ctx.params[0]) ? ctx.params[0] : ctx.query.tab && tabs.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : 'book';
    let q = '', lowOnly = ctx.query.low === '1';
    const tabHost = h('div');
    const actions = h('div', { class: 'row' });
    const body = h('div', { class: 'stack' });

    const draw = () => {
      ui.clear(tabHost); ui.clear(actions); ui.clear(body);
      if (tabs.length > 1) tabHost.append(ui.tabs(tabs, tab, (t) => { tab = t; q = ''; history.replaceState(null, '', '#/inventory/' + t); draw(); }));
      if (tab === 'book') drawBook();
      else if (tab === 'stock') drawStock();
      else if (tab === 'moves') drawMoves();
      else if (tab === 'counts') drawCounts();
      else if (tab === 'valuation') drawValuation();
      else drawLocations();
    };
    const locks = () => locksFrom(store.settings(), store.list('payrollRuns'));
    const zone = () => zoneFor(store.settings().company?.province);

    // ----- price book -----
    function drawBook() {
      actions.append(
        ui.button('Export CSV', { icon: 'download', onClick: exportCsv }),
        ui.button('New item', { variant: 'primary', icon: 'plus', onClick: () => editItem() }));
      const items = store.list('items');
      const tableHost = h('div');
      const drawTable = () => {
        const n = q.trim().toLowerCase();
        const rows = items.filter((i) => !n || [i.name, i.sku, i.category].some((s) => (s || '').toLowerCase().includes(n)))
          .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
        ui.clear(tableHost);
        tableHost.append(ui.table({
          columns: [
            { key: 'sku', label: 'SKU', render: (i) => h('span', { class: 'mono' }, i.sku || '—'), sort: (i) => i.sku || '' },
            { key: 'name', label: 'Name', sort: (i) => i.name },
            { key: 'category', label: 'Category', sort: (i) => i.category || '' },
            { key: 'unit', label: 'Unit' },
            { key: 'cost', label: 'Cost', align: 'right', render: (i) => ui.fmtMoney(i.costCents), sort: (i) => i.costCents },
            { key: 'price', label: 'Price', align: 'right', render: (i) => ui.fmtMoney(i.priceCents), sort: (i) => i.priceCents },
            { key: 'margin', label: 'Margin', align: 'right', render: (i) => marginCell(ui, i), sort: (i) => margin(i) ?? -1 },
            { key: 'labour', label: 'Labour h', align: 'right', render: (i) => ui.fmtNum(i.labourHours, 2), sort: (i) => i.labourHours || 0 },
            { key: 'symbol', label: 'Canvas symbol', render: (i) => (i.symbol ? ui.badge(i.symbol, 'info') : h('span', { class: 'muted' }, '—')), sort: (i) => i.symbol || '' },
          ],
          rows,
          onRowClick: (i) => editItem(i),
          empty: ui.empty({ icon: 'box', title: items.length ? 'No items match' : 'Your price book is empty',
            text: items.length ? 'Try another search.' : 'Add the devices, wire and gear you install, with your sell price.',
            action: items.length ? null : ui.button('New item', { variant: 'primary', icon: 'plus', onClick: () => editItem() }) }),
        }));
      };
      body.append(h('div', { class: 'row' }, ui.searchBox('Search name, SKU or category', (v) => { q = v; drawTable(); }, q),
        h('span', { class: 'muted' }, `${items.length} items`)), tableHost);
      drawTable();
    }

    function editItem(item) {
      const s = store.settings();
      const isNew = !item;
      const it = item || { sku: '', name: '', category: '', unit: 'ea', costCents: 0, priceCents: 0, labourHours: 0, reorderPoint: 0, stock: {}, symbol: null };
      const suggest = ui.button(`Suggest price (cost + ${s.markupPct ?? 0}%)`, { size: 'sm', icon: 'zap', onClick: () => {
        const form = suggest.closest('form');
        const cost = ui.parseMoney(form.querySelector('[name=costCents]').value);
        form.querySelector('[name=priceCents]').value = ui.centsToInput(Math.round(cost * (1 + (Number(s.markupPct) || 0) / 100)));
      } });
      ui.formSheet({
        title: isNew ? 'New price book item' : it.name,
        submitLabel: isNew ? 'Add item' : 'Save',
        fields: [
          { label: 'Name', name: 'name', value: it.name, required: true, span: true },
          { label: 'SKU', name: 'sku', value: it.sku },
          { label: 'Category', name: 'category', value: it.category, placeholder: 'Devices, Wire, Gear…' },
          { label: 'Unit', name: 'unit', value: it.unit, placeholder: 'ea, ft, stick' },
          { label: 'Cost', name: 'costCents', type: 'money', value: it.costCents },
          { label: 'Sell price', name: 'priceCents', type: 'money', value: it.priceCents, hint: 'Installed price shown on estimates' },
          { label: 'Labour hours per unit', name: 'labourHours', type: 'number', step: '0.05', min: '0', value: it.labourHours },
          { label: 'Reorder point', name: 'reorderPoint', type: 'number', step: '1', min: '0', value: it.reorderPoint, hint: 'Low-stock alert below this total' },
          { label: 'Canvas symbol (for takeoff)', name: 'symbol', type: 'select', value: it.symbol || '', options: [{ value: '', label: '— none —' }, ...SYMBOL_IDS.map((x) => ({ value: x, label: x }))] },
        ],
        extra: h('div', { class: 'row' }, suggest),
        danger: isNew ? null : { label: 'Delete item', onClick: () => deleteItem(it) },
        onSubmit: (v) => {
          const rec = { ...v, symbol: v.symbol || null, labourHours: v.labourHours || 0, reorderPoint: v.reorderPoint || 0 };
          if (isNew) { store.add('items', { ...rec, stock: {} }); ui.toast('Item added', 'success'); }
          else { store.update('items', it.id, rec); ui.toast('Item saved', 'success'); }
        },
      });
    }
    async function deleteItem(it) {
      if (!(await ui.confirmDialog(`Delete ${it.name} from the price book? Existing estimates keep their lines.`, { okLabel: 'Delete' }))) return;
      store.remove('items', it.id);
      ui.toast('Item deleted');
    }
    function exportCsv() {
      const cols = ['sku', 'name', 'category', 'unit', 'cost', 'price', 'labourHours', 'reorderPoint', 'symbol', 'stockTotal'];
      const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = store.list('items').sort((a, b) => a.name.localeCompare(b.name)).map((i) => [
        i.sku, i.name, i.category, i.unit, ui.centsToInput(i.costCents), ui.centsToInput(i.priceCents), i.labourHours ?? 0, i.reorderPoint ?? 0, i.symbol || '', itemTotal(i),
      ].map(esc).join(','));
      ui.download(`price-book-${ui.today()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
      store.log('export', 'Price book exported to CSV', 'items');
    }

    // ----- stock -----
    function drawStock() {
      actions.append(
        ui.button('Receive', { icon: 'box', onClick: () => receiveSheet(ctx, {}) }),
        ui.button('Record move', { variant: 'primary', icon: 'truck', onClick: () => recordMove() }));
      const locs = store.list('locations').sort((a, b) => a.name.localeCompare(b.name));
      const items = store.list('items');
      const low = items.filter(isLow);
      const tableHost = h('div');
      const drawTable = () => {
        const n = q.trim().toLowerCase();
        const rows = items.filter((i) => (!lowOnly || isLow(i)) && (!n || [i.name, i.sku, i.category].some((s) => (s || '').toLowerCase().includes(n))))
          .sort((a, b) => a.name.localeCompare(b.name));
        ui.clear(tableHost);
        tableHost.append(ui.table({
          columns: [
            { key: 'name', label: 'Item', render: (i) => h('div', null, h('div', null, i.name), h('div', { class: 'muted mono inv-sku' }, i.sku || '')), sort: (i) => i.name },
            ...locs.map((l) => ({ key: 'loc-' + l.id, label: l.name, align: 'right', render: (i) => ui.fmtNum(i.stock?.[l.id] || 0), sort: (i) => i.stock?.[l.id] || 0 })),
            { key: 'total', label: 'Total', align: 'right', render: (i) => h('strong', null, ui.fmtNum(itemTotal(i))), sort: itemTotal },
            { key: 'reorder', label: 'Reorder at', align: 'right', render: (i) => (i.reorderPoint ? ui.fmtNum(i.reorderPoint) : '—'), sort: (i) => i.reorderPoint || 0 },
            { key: 'state', label: '', render: (i) => (isLow(i) ? ui.badge('low stock', 'danger') : ''), sort: (i) => (isLow(i) ? 0 : 1) },
          ],
          rows,
          onRowClick: (i) => recordMove({ itemId: i.id }),
          empty: ui.empty({ icon: 'box', title: lowOnly ? 'Nothing is low' : 'No items', text: lowOnly ? 'Every item is at or above its reorder point.' : 'Add items in the price book first.' }),
        }));
      };
      h(body, null,
        h('div', { class: 'grid money-stats' },
          ui.stat({ label: 'Items stocked', value: ui.fmtNum(items.filter((i) => itemTotal(i) > 0).length) }),
          ui.stat({ label: 'Low stock', value: ui.fmtNum(low.length), tone: low.length ? 'danger' : 'success', hint: low.length ? 'below reorder point' : 'all good' }),
          ui.stat({ label: 'Stock value (cost)', value: ui.fmtMoney(items.reduce((s, i) => s + itemTotal(i) * (i.costCents || 0), 0), { whole: true }) })),
        h('div', { class: 'row' },
          ui.searchBox('Search stock', (v) => { q = v; drawTable(); }, q),
          h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: lowOnly, onChange: (e) => { lowOnly = e.target.checked; drawTable(); } }), h('span', null, 'Low stock only'))),
        tableHost);
      drawTable();
    }

    function recordMove(pre = {}) {
      const locs = store.list('locations').sort((a, b) => a.name.localeCompare(b.name));
      if (!locs.length) { ui.toast('Add a location first', 'error'); tab = 'locations'; draw(); return; }
      const items = store.list('items').sort((a, b) => a.name.localeCompare(b.name));
      const jobs = store.list('jobs', (j) => !['complete', 'invoiced'].includes(j.status));
      const locOpts = ui.recordOptions(locs, 'name', '— none —');
      const sheet = ui.formSheet({
        title: 'Record stock move',
        submitLabel: 'Record move',
        fields: [
          { label: 'Type', name: 'type', type: 'select', value: pre.type || 'transfer', options: MOVE_TYPES, span: true },
          { label: 'Item', name: 'itemId', type: 'select', value: pre.itemId || '', options: ui.recordOptions(items, (i) => `${i.name}${i.sku ? ` (${i.sku})` : ''}`, '— pick an item —'), required: true, span: true },
          { label: 'From location', name: 'fromLocationId', type: 'select', value: locs.find((l) => l.kind === 'shop')?.id || '', options: locOpts },
          { label: 'To location', name: 'toLocationId', type: 'select', value: locs.find((l) => l.kind === 'van')?.id || '', options: locOpts },
          { label: 'Quantity', name: 'qty', type: 'number', step: 'any', min: '0', value: 1, required: true },
          { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
          { label: 'Job', name: 'jobId', type: 'select', value: '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) },
          { label: 'Use', name: 'use', type: 'select', value: '', options: [{ value: '', label: 'Billed to the job (resale)' }, ...OWN_USE_REASONS.map((x) => ({ value: x, label: `Own use: ${OWN_USE_REASON_LABEL[x]}` }))],
            hint: 'Own use (warranty, no charge, shop, truck, tools) is not resold: its RST is self-assessed.' },
          { label: 'Note', name: 'note', span: true },
        ],
        onSubmit: (v) => {
          if (v.type === 'use') { v.ownUseReason = v.use || null; v.use = v.use ? 'own-use' : 'job'; } else { delete v.use; }
          const res = applyMove(store, v);
          if (res.error) { ui.toast(res.error, 'error'); return false; }
          ui.toast(res.warning || 'Stock updated', res.warning ? 'info' : 'success', res.warning ? 4000 : 2600);
        },
      });
      // show/hide from/to by type
      const form = sheet.el.querySelector('form');
      const typeSel = form.querySelector('[name=type]');
      const useSel = form.querySelector('[name=use]');
      const jobSel = form.querySelector('[name=jobId]');
      const sync = () => {
        const t = typeSel.value;
        form.querySelector('[name=fromLocationId]').closest('.field').hidden = t === 'receive';
        form.querySelector('[name=toLocationId]').closest('.field').hidden = t === 'use';
        useSel.closest('.field').hidden = t !== 'use';
      };
      // A warranty, callback or unbilled job's material is own use by default.
      jobSel.addEventListener('change', () => {
        const job = jobSel.value ? store.get('jobs', jobSel.value) : null;
        useSel.value = ownUseJob(job) ? (['warranty', 'callback'].includes(job.kind) ? 'warranty' : 'no-charge') : '';
      });
      typeSel.addEventListener('change', sync);
      sync();
    }

    // ----- moves -----
    function drawMoves() {
      actions.append(ui.button('Record move', { variant: 'primary', icon: 'truck', onClick: () => recordMove() }));
      const moves = store.list('stockMoves').sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
      const locName = (id) => (id ? store.get('locations', id)?.name || '?' : null);
      body.append(ui.table({
        columns: [
          { key: 'date', label: 'Date', render: (m) => ui.fmtDate(m.date), sort: (m) => m.date || '' },
          { key: 'item', label: 'Item', render: (m) => store.get('items', m.itemId)?.name || '(deleted item)' },
          { key: 'route', label: 'Move', render: (m) => moveLabel(m, locName) },
          { key: 'qty', label: 'Qty', align: 'right', render: (m) => ui.fmtNum(m.qty, Number.isInteger(m.qty) ? 0 : 2), sort: (m) => m.qty },
          { key: 'job', label: 'Job', render: (m) => (m.jobId ? h('a', { href: '#/jobs/' + m.jobId, onClick: (e) => e.stopPropagation() }, store.get('jobs', m.jobId)?.number || 'job') : '—') },
          { key: 'use', label: 'Use', render: (m) => (m.use === 'own-use' ? ui.badge(`own use${m.ownUseReason ? `: ${OWN_USE_REASON_LABEL[m.ownUseReason] || m.ownUseReason}` : ''}`, 'warning')
            : m.use === 'adjust' ? ui.badge('count', 'neutral') : m.use === 'receive' ? ui.badge('received', 'info') : m.reversesId ? ui.badge('reversal', 'neutral') : '') },
          { key: 'note', label: 'Note', render: (m) => m.note || '' },
          { key: 'x', label: '', render: (m) => (isLocked(locks(), 'stockMoves', m, { zone: zone() })
            // A move in a closed period changes by an opposite move dated today (2.6).
            ? (store.list('stockMoves', (x) => x.reversesId === m.id).length ? h('span', { class: 'muted' }, 'reversed') : ui.button(REVERSAL_ACTION.stockMoves, { size: 'sm', variant: 'ghost', icon: 'lock', title: 'In a closed period', onClick: async (e) => {
              e.stopPropagation();
              if (!(await ui.confirmDialog('Record the opposite move dated today? The original stays in its closed month.', { okLabel: REVERSAL_ACTION.stockMoves, danger: false }))) return;
              reverseLockedMove(store, m, ui.today());
              ui.toast('Reversed today', 'success');
            } }))
            : ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Undo move', onClick: async (e) => {
              e.stopPropagation();
              if (!(await ui.confirmDialog('Undo this move? Stock goes back to where it was.', { okLabel: 'Undo move' }))) return;
              const reopened = undoMove(store, m);
              ui.toast(reopened ? 'Move undone. The material request is open again.' : 'Move undone');
            } })) },
        ],
        rows: moves,
        empty: ui.empty({ icon: 'truck', title: 'No stock moves yet', text: 'Record restocking vans, receiving orders and material used on jobs.',
          action: ui.button('Record move', { variant: 'primary', icon: 'plus', onClick: () => recordMove() }) }),
      }));
    }

    // ----- count sheets (8.4) -----
    function drawCounts() {
      const locs = store.list('locations').sort((a, b) => a.name.localeCompare(b.name));
      actions.append(ui.button('New count', { variant: 'primary', icon: 'plus', onClick: () => newCount(ctx, locs) }));
      const counts = store.list('stockCounts').sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      body.append(
        h('p', { class: 'muted' }, 'Count a location on a phone (it works offline), then post it: one adjustment per difference, against what was there when it was counted. Adjustments are never own use.'),
        ui.table({
          columns: [
            { key: 'date', label: 'Date', render: (c) => ui.fmtDate(c.date), sort: (c) => c.date || '' },
            { key: 'loc', label: 'Location', render: (c) => store.get('locations', c.locationId)?.name || '—' },
            { key: 'progress', label: 'Counted', render: (c) => { const p = countProgress(c); return `${p.counted} of ${p.lines}${p.differ ? ` · ${p.differ} differ` : ''}`; } },
            { key: 'status', label: 'Status', render: (c) => ui.badge(COUNT_STATUS_LABEL[c.status] || c.status, c.status === 'posted' ? 'success' : c.status === 'counted' ? 'info' : 'neutral') },
          ],
          rows: counts,
          onRowClick: (c) => openCount(ctx, c.id),
          empty: ui.empty({ icon: 'list', title: 'No counts yet', text: 'Start one for the shop or a van.', action: ui.button('New count', { variant: 'primary', icon: 'plus', onClick: () => newCount(ctx, locs) }) }),
        }));
    }

    // ----- valuation as of a day (8.4) -----
    let valuationAsOf = ui.today();
    function drawValuation() {
      const asOf = h('input', { type: 'date', name: 'asOf', value: valuationAsOf });
      asOf.addEventListener('change', () => { valuationAsOf = asOf.value || ui.today(); draw(); });
      const v = valuationByLocation({ items: store.list('items'), stockMoves: store.list('stockMoves'), locations: store.list('locations'), asOf: valuationAsOf });
      const total = v.reduce((s, x) => s + x.valueCents, 0);
      actions.append(ui.button('Export CSV', { icon: 'download', onClick: () => {
        const esc = (x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const rows = [['Location', 'Item', 'Qty', 'Average cost', 'Value'].join(',')];
        for (const loc of v) for (const l of loc.lines) rows.push([loc.name, l.name, l.qty, ui.centsToInput(l.avgCents), ui.centsToInput(l.valueCents)].map(esc).join(','));
        rows.push(['Total', '', '', '', ui.centsToInput(total)].join(','));
        ui.download(`inventory-${valuationAsOf}.csv`, rows.join('\n'), 'text/csv');
        store.log('export', `Inventory valuation ${valuationAsOf}`, 'items');
      } }));
      body.append(
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'As of'), asOf), h('span', { class: 'grow' }), h('strong', null, `Total ${ui.fmtMoney(total, { whole: true })}`)),
        h('p', { class: 'muted' }, 'The quantity at each location on that day (today\'s stock with later moves rolled back) at the moving average cost then. Items never received through a purchase order use their price-book cost.'),
        v.length ? h('div', { class: 'stack' }, v.map((loc) => h('details', { class: 'card' },
          h('summary', { class: 'row' }, h('strong', { class: 'grow' }, loc.name), h('span', { class: 'num' }, ui.fmtMoney(loc.valueCents))),
          loc.lines.length ? ui.table({
            columns: [
              { key: 'name', label: 'Item' },
              { key: 'qty', label: 'Qty', align: 'right', render: (l) => ui.fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 2) },
              { key: 'avg', label: 'Average cost', align: 'right', render: (l) => ui.fmtMoney(l.avgCents) },
              { key: 'val', label: 'Value', align: 'right', render: (l) => ui.fmtMoney(l.valueCents) },
            ],
            rows: loc.lines,
          }) : h('p', { class: 'muted' }, 'Nothing here on that day.'))))
          : ui.empty({ icon: 'map-pin', title: 'No locations', text: 'Add your shop and vans first.' }));
    }

    // ----- locations -----
    function drawLocations() {
      actions.append(ui.button('New location', { variant: 'primary', icon: 'plus', onClick: () => editLocation() }));
      const locs = store.list('locations').sort((a, b) => a.name.localeCompare(b.name));
      const items = store.list('items');
      body.append(locs.length ? h('div', { class: 'grid' }, locs.map((l) => {
        const units = items.reduce((s, i) => s + (Number(i.stock?.[l.id]) || 0), 0);
        const value = items.reduce((s, i) => s + (Number(i.stock?.[l.id]) || 0) * (i.costCents || 0), 0);
        return h('div', { class: 'card click', tabindex: 0, onClick: () => editLocation(l), onKeydown: (e) => { if (e.key === 'Enter') editLocation(l); } },
          h('div', { class: 'row' }, ui.icon(l.kind === 'van' ? 'truck' : l.kind === 'site' ? 'map-pin' : 'home', 20), h('h3', { style: { margin: 0 } }, l.name), h('span', { class: 'grow' }), ui.badge(l.kind)),
          h('p', { class: 'muted', style: { margin: '8px 0 0' } }, `${ui.fmtNum(units)} units · ${ui.fmtMoney(value, { whole: true })} at cost`));
      })) : ui.empty({ icon: 'map-pin', title: 'No locations', text: 'Add your shop, each van, and any site containers.', action: ui.button('New location', { variant: 'primary', icon: 'plus', onClick: () => editLocation() }) }));
    }
    function editLocation(l) {
      const isNew = !l;
      ui.formSheet({
        title: isNew ? 'New location' : l.name,
        fields: [
          { label: 'Name', name: 'name', value: l?.name || '', required: true },
          { label: 'Kind', name: 'kind', type: 'select', value: l?.kind || 'van', options: ['shop', 'van', 'site'] },
        ],
        danger: isNew ? null : { label: 'Delete location', onClick: () => deleteLocation(l) },
        onSubmit: (v) => { if (isNew) store.add('locations', v); else store.update('locations', l.id, v); ui.toast('Location saved', 'success'); },
      });
    }
    async function deleteLocation(l) {
      const items = store.list('items', (i) => Number(i.stock?.[l.id]) > 0);
      const msg = items.length ? `${l.name} still holds stock of ${items.length} item${items.length > 1 ? 's' : ''}. Deleting it removes that stock from the counts.` : `Delete ${l.name}?`;
      if (!(await ui.confirmDialog(msg, { okLabel: 'Delete' }))) return;
      for (const i of store.list('items', (x) => x.stock && l.id in x.stock)) {
        const stock = { ...i.stock }; delete stock[l.id];
        store.update('items', i.id, { stock }, { silent: true });
      }
      store.remove('locations', l.id);
      ui.toast('Location deleted');
    }

    root.append(ui.page(stockOn(store)
      ? { title: 'Inventory', subtitle: 'Price book, stock in the shop and vans, and what moved where', actions: [actions] }
      : { title: 'Price book', subtitle: 'Your items with cost and sell prices', actions: [actions] }, tabHost, h('div', { style: { height: '16px' } }), body));
    draw();
    if (tab === 'counts' && ctx.params[1]) openCount(ctx, ctx.params[1]);
    // Redraw on data changes, but not under an open sheet (it would steal the form);
    // changes made from a sheet are drawn once the sheet closes.
    let dirty = false;
    const overlay = () => document.querySelector('.sheet, .dialog');
    const unsub = store.on('*', (e) => {
      if (!['items', 'locations', 'stockMoves', 'stockCounts', 'settings'].includes(e.coll)) return;
      if (overlay()) dirty = true; else draw();
    });
    const obs = new MutationObserver(() => { if (dirty && !overlay()) { dirty = false; draw(); } });
    obs.observe(document.body, { childList: true });
    return () => { unsub(); obs.disconnect(); };
  },
};

function margin(i) {
  if (!i.priceCents) return null;
  return ((i.priceCents - (i.costCents || 0)) / i.priceCents) * 100;
}
function marginCell(ui, i) {
  const m = margin(i);
  if (m == null) return '—';
  return ui.h('span', { class: m < 20 ? 'inv-margin-low' : null }, `${ui.fmtNum(m, 0)}%`);
}

function moveLabel(m, locName) {
  const from = locName(m.fromLocationId), to = locName(m.toLocationId);
  if (from && to) return `${from} → ${to}`;
  if (to) return `Received → ${to}`;
  if (from) return `${from} → used${m.jobId ? ' on job' : ''}`;
  return '—';
}

/** Apply a move form to item stock and record it. Returns { error } or { move, warning }. */
export function applyMove(store, v) {
  const qty = Number(v.qty);
  if (!(qty > 0)) return { error: 'Quantity must be above zero' };
  const it = store.get('items', v.itemId);
  if (!it) return { error: 'Pick an item' };
  const type = v.type || 'transfer';
  const from = type === 'receive' ? null : v.fromLocationId || null;
  const to = type === 'use' ? null : v.toLocationId || null;
  if (type === 'transfer' && (!from || !to)) return { error: 'A transfer needs both a from and a to location' };
  if (type === 'transfer' && from === to) return { error: 'From and to are the same location' };
  if (type === 'receive' && !to) return { error: 'Pick the location receiving the stock' };
  if (type === 'use' && !from) return { error: 'Pick the location the stock came from' };
  const stock = { ...(it.stock || {}) };
  let warning = null;
  if (from) {
    const have = Number(stock[from]) || 0;
    if (have < qty) warning = `Only ${have} recorded at that location, so it is now negative. Count it when you can.`;
    stock[from] = have - qty;
  }
  if (to) stock[to] = (Number(stock[to]) || 0) + qty;
  store.update('items', it.id, { stock }, { summary: `stock ${it.name}` });
  const move = store.add('stockMoves', {
    itemId: it.id, fromLocationId: from, toLocationId: to, qty, jobId: v.jobId || null, date: v.date || new Date().toISOString().slice(0, 10), note: v.note || '',
    // Release 1 tags (3.5): job use or own use with its reason, and the cost code.
    ...(v.use ? { use: v.use } : {}), ...(v.use === 'own-use' ? { ownUseReason: v.ownUseReason || 'other' } : {}), ...(v.costCodeId ? { costCodeId: v.costCodeId } : {}),
  });
  return { move, warning };
}

/**
 * A move in a closed period changes by the opposite move dated today (r1-get-paid.md 2.6): from where
 * it went, back to where it came from, with reversesId. A use on a job comes back as a return.
 */
export function reverseLockedMove(store, m, today) {
  const it = store.get('items', m.itemId);
  if (it) {
    const stock = { ...(it.stock || {}) };
    if (m.fromLocationId) stock[m.fromLocationId] = (Number(stock[m.fromLocationId]) || 0) + Number(m.qty);
    if (m.toLocationId) stock[m.toLocationId] = (Number(stock[m.toLocationId]) || 0) - Number(m.qty);
    store.update('items', it.id, { stock }, { summary: `reverse stock move ${it.name}` });
  }
  return store.add('stockMoves', {
    itemId: m.itemId || null, fromLocationId: m.toLocationId || null, toLocationId: m.fromLocationId || null, qty: Number(m.qty), jobId: m.jobId || null,
    date: today, reversesId: m.id, ...(m.use === 'own-use' ? { use: 'own-use', ownUseReason: m.ownUseReason || 'other' } : {}), ...(m.costCodeId ? { costCodeId: m.costCodeId } : {}),
    note: `Reverses the move of ${m.date || ''}`.trim(),
  });
}

// ---- count sheets (r1-get-paid.md 8.4) ---------------------------------------------------------

function newCount(ctx, locs) {
  const { store, ui } = ctx;
  if (!locs.length) { ui.toast('Add a location first', 'error'); return; }
  ui.formSheet({
    title: 'New count',
    submitLabel: 'Start counting',
    fields: [
      { label: 'Location', name: 'locationId', type: 'select', value: locs.find((l) => l.kind === 'van')?.id || locs[0].id, options: locs.map((l) => ({ value: l.id, label: l.name })), span: true },
      { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
      { label: 'List every item, not only what should be there', name: 'all', type: 'checkbox', value: false, span: true },
    ],
    onSubmit: (v) => {
      const sheet = countSheet({ items: store.list('items'), locationId: v.locationId, date: v.date || ui.today(), all: v.all });
      if (!sheet.lines.length) { ui.toast('Nothing is recorded at that location: tick "List every item"', 'error', 4000); return false; }
      const rec = store.add('stockCounts', sheet);
      setTimeout(() => openCount(ctx, rec.id), 0);
    },
  });
}

/**
 * The count sheet on a phone: type what is there (saved as you go, offline), "Done counting" stamps
 * the moment, and a manager posts it: one adjustment move per difference, against the quantity at
 * that moment. Exported for screens that let a van owner count their own van.
 */
export function openCount(ctx, id) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const count = store.get('stockCounts', id);
  if (!count) { ui.toast('This count no longer exists', 'error'); return; }
  const items = new Map(store.list('items').map((i) => [i.id, i]));
  const loc = store.get('locations', count.locationId);
  const editable = ['draft', 'counted'].includes(count.status);
  const canPost = auth.can('inventory') && auth.isManager();
  const lines = (count.lines || []).map((l) => ({ ...l }));
  let timer = null;
  const save = () => { clearTimeout(timer); timer = null; store.update('stockCounts', id, { lines }, { summary: `count ${loc?.name || ''}` }); };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 600); };
  const rows = lines.map((l) => {
    const it = items.get(l.itemId);
    const diff = h('span', { class: 'diff' });
    const show = () => {
      const c = l.countedQty;
      const d = c == null || c === '' ? null : Math.round((Number(c) - Number(l.expectedQty || 0)) * 1000) / 1000;
      diff.textContent = d == null ? '' : d === 0 ? 'matches' : `${d > 0 ? '+' : ''}${d}`;
      diff.className = ['diff', d ? 'off' : null].filter(Boolean).join(' ');
    };
    const input = h('input', { class: 'input num', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.countedQty ?? '', readonly: !editable, 'aria-label': `${it?.name || 'Item'} counted` });
    input.addEventListener('input', () => { l.countedQty = input.value === '' ? null : Number(input.value); show(); later(); });
    show();
    return h('div', { class: 'cnt-line', dataset: { item: l.itemId } },
      h('div', null, h('strong', null, it?.name || 'Deleted item'), h('div', { class: 'muted' }, `expected ${l.expectedQty} ${it?.unit || ''}`)), input, diff);
  });
  const sheet = ui.openSheet({
    title: `Count: ${loc?.name || 'location'} · ${ui.fmtDate(count.date)}`,
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, editable ? 'Type what is there. It saves as you go and works offline.' : `${COUNT_STATUS_LABEL[count.status] || count.status}.`),
      h('div', { class: 'cnt-lines' }, rows)),
    onClose: () => { if (timer) save(); },
    actions: [
      editable && count.status !== 'posted' ? ui.button('Void', { variant: 'ghost danger', onClick: async () => {
        if (!(await ui.confirmDialog('Void this count? Nothing is adjusted.', { okLabel: 'Void' }))) return;
        clearTimeout(timer); timer = null;
        store.update('stockCounts', id, { status: 'void' });
        sheet.close();
      } }) : null,
      h('span', { class: 'grow' }),
      editable && count.status === 'draft' ? ui.button('Done counting', { onClick: () => {
        clearTimeout(timer); timer = null;
        store.update('stockCounts', id, { lines, status: 'counted', countedAt: new Date().toISOString(), countedBy: String(auth.who().name || '').slice(0, 120) || null });
        ui.toast(canPost ? 'Counted. Post it to adjust stock.' : 'Counted. The office posts it.', 'success');
        sheet.close();
      } }) : null,
      editable && canPost ? ui.button('Post', { variant: 'primary', icon: 'check', onClick: async () => {
        clearTimeout(timer); timer = null;
        const cur = { ...store.get('stockCounts', id), lines, countedAt: store.get('stockCounts', id)?.countedAt || new Date().toISOString() };
        const problems = countProblems(cur);
        if (problems.length) { ui.toast(problems[0], 'error', 4000); return; }
        const adj = countAdjustments(cur, { items: store.list('items'), stockMoves: store.list('stockMoves') });
        if (!(await ui.confirmDialog(adj.length ? `Post ${adj.length} adjustment${adj.length === 1 ? '' : 's'} to ${loc?.name || 'this location'}?` : 'Everything matches. Post the count?', { okLabel: 'Post', danger: false }))) return;
        const moveIds = postCount(store, cur, adj);
        store.update('stockCounts', id, { lines, status: 'posted', countedAt: cur.countedAt, postedAt: new Date().toISOString(), postedBy: String(auth.who().name || '').slice(0, 120) || null, moveIds });
        ui.toast(`Posted${adj.length ? `: ${adj.length} adjustment${adj.length === 1 ? '' : 's'}` : ''}`, 'success');
        sheet.close();
      } }) : null,
    ].filter(Boolean),
  });
}

/** Apply a count's adjustments: each item's stock at the location moves by the difference, one move each. */
export function postCount(store, count, adjustments) {
  const ids = [];
  for (const a of adjustments) {
    const it = store.get('items', a.itemId);
    if (!it) continue;
    const stock = { ...(it.stock || {}) };
    stock[count.locationId] = Math.round(((Number(stock[count.locationId]) || 0) + a.diff) * 1000) / 1000;
    store.update('items', it.id, { stock }, { summary: `count ${it.name}` });
    ids.push(store.add('stockMoves', a.move).id);
  }
  return ids;
}

/**
 * Undo a move: stock goes back, the move goes, and a material request it fulfilled ("From stock")
 * opens again, so it is neither left pointing at a missing move nor billed or costed as used.
 * Returns how many requests were reopened.
 */
export function undoMove(store, m) {
  reverseMove(store, m);
  store.remove('stockMoves', m.id);
  const reqs = store.list('materialRequests', (r) => r.stockMoveId === m.id);
  for (const r of reqs) store.update('materialRequests', r.id, reopenAfterUndo(r), { summary: 'stock move undone' });
  return reqs.length;
}

export function reverseMove(store, m) {
  const it = store.get('items', m.itemId);
  if (!it) return;
  const stock = { ...(it.stock || {}) };
  if (m.fromLocationId) stock[m.fromLocationId] = (Number(stock[m.fromLocationId]) || 0) + Number(m.qty);
  if (m.toLocationId) stock[m.toLocationId] = (Number(stock[m.toLocationId]) || 0) - Number(m.qty);
  store.update('items', it.id, { stock }, { summary: `undo stock move ${it.name}` });
}
