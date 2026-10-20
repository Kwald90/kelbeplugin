// Inventory (S19): price book, stock by location, stock moves, locations.
import { SYMBOL_IDS } from '../seed.js';
import { store as appStore } from '../store.js';
import { switchOn } from '../lib/modules.js';
import { reopenAfterUndo } from '../lib/materials.js';

/** Stock (shop, vans, moves) can be turned off while the price book stays (Settings → Modules). */
const stockOn = (store) => switchOn(store.settings(), 'inventory');

const TABS = [
  { id: 'book', label: 'Price book' }, { id: 'stock', label: 'Stock' },
  { id: 'moves', label: 'Moves' }, { id: 'locations', label: 'Locations' },
];
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
    const { store, ui } = ctx;
    const { h } = ui;
    const tabs = stockOn(store) ? TABS : TABS.filter((t) => t.id === 'book');
    let tab = tabs.some((t) => t.id === ctx.params[0]) ? ctx.params[0] : 'book';
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
      else drawLocations();
    };

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
      actions.append(ui.button('Record move', { variant: 'primary', icon: 'truck', onClick: () => recordMove() }));
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
          { label: 'Note', name: 'note', span: true },
        ],
        onSubmit: (v) => {
          const res = applyMove(store, v);
          if (res.error) { ui.toast(res.error, 'error'); return false; }
          ui.toast(res.warning || 'Stock updated', res.warning ? 'info' : 'success', res.warning ? 4000 : 2600);
        },
      });
      // show/hide from/to by type
      const form = sheet.el.querySelector('form');
      const typeSel = form.querySelector('[name=type]');
      const sync = () => {
        const t = typeSel.value;
        form.querySelector('[name=fromLocationId]').closest('.field').hidden = t === 'receive';
        form.querySelector('[name=toLocationId]').closest('.field').hidden = t === 'use';
      };
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
          { key: 'note', label: 'Note', render: (m) => m.note || '' },
          { key: 'x', label: '', render: (m) => ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Undo move', onClick: async (e) => {
            e.stopPropagation();
            if (!(await ui.confirmDialog('Undo this move? Stock goes back to where it was.', { okLabel: 'Undo move' }))) return;
            const reopened = undoMove(store, m);
            ui.toast(reopened ? 'Move undone. The material request is open again.' : 'Move undone');
          } }) },
        ],
        rows: moves,
        empty: ui.empty({ icon: 'truck', title: 'No stock moves yet', text: 'Record restocking vans, receiving orders and material used on jobs.',
          action: ui.button('Record move', { variant: 'primary', icon: 'plus', onClick: () => recordMove() }) }),
      }));
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
    // Redraw on data changes, but not under an open sheet (it would steal the form);
    // changes made from a sheet are drawn once the sheet closes.
    let dirty = false;
    const overlay = () => document.querySelector('.sheet, .dialog');
    const unsub = store.on('*', (e) => {
      if (!['items', 'locations', 'stockMoves'].includes(e.coll)) return;
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
  const move = store.add('stockMoves', { itemId: it.id, fromLocationId: from, toLocationId: to, qty, jobId: v.jobId || null, date: v.date || new Date().toISOString().slice(0, 10), note: v.note || '' });
  return { move, warning };
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
