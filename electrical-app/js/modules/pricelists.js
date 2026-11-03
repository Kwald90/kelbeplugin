// Supplier price-list import (#/pricelists): paste or upload a distributor price file (EECOL,
// Westburne, …), map its columns, and update the price book's costs by part number. The pragmatic
// path that works today without a distributor API. Pure logic: js/lib/pricelist.js.
import { parseCsv, guessMapping, planUpdate, summarize } from '../lib/pricelist.js';
import { moneyFormatter } from '../lib/money.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/pricelists.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/pricelists.css';
  document.head.append(link);
}

export default {
  id: 'pricelists',
  title: 'Price lists',
  icon: 'box',
  group: 'money',
  perm: 'inventory',
  render(root, ctx) { loadCss(); return importView(root, ctx); },
};

function importView(root, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const vendors = store.list('vendors').sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const state = { parsed: null, mapping: null, supplier: '', createMissing: false, updateSell: false };

  const stage = h('div', { class: 'stack' });

  const supplierField = h('select', { class: 'input pl-input' },
    h('option', { value: '' }, 'Supplier (optional)'),
    vendors.map((v) => h('option', { value: v.name }, v.name)));
  supplierField.addEventListener('change', () => { state.supplier = supplierField.value; });

  const textarea = h('textarea', { class: 'input pl-paste', rows: 6, placeholder: 'Paste the price file here (CSV), or choose a .csv file below' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { textarea.value = String(reader.result || ''); doParse(); };
    reader.onerror = () => ui.toast('Could not read that file', 'error');
    reader.readAsText(f);
  });

  function doParse() {
    const parsed = parseCsv(textarea.value);
    if (!parsed.headers.length) { ui.toast('No columns found — is this CSV?', 'error'); return; }
    state.parsed = parsed;
    state.mapping = guessMapping(parsed.headers);
    drawStage();
  }

  const colSelect = (label, key) => {
    const sel = h('select', { class: 'input' },
      h('option', { value: '-1' }, '—'),
      state.parsed.headers.map((hh, i) => h('option', { value: String(i), selected: state.mapping[key] === i }, hh || `Column ${i + 1}`)));
    sel.addEventListener('change', () => { state.mapping[key] = Number(sel.value); drawStage(); });
    return h('label', { class: 'field' }, h('span', null, label), sel);
  };

  function drawStage() {
    ui.clear(stage);
    stage.append(
      h('section', { class: 'card' }, h('h3', null, '1. The price file'),
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Supplier'), supplierField)),
        textarea,
        h('div', { class: 'row pl-fileline' }, file, ui.button('Parse', { variant: 'primary', icon: 'check', onClick: doParse }))));

    if (!state.parsed) return;
    const { mapping, parsed } = state;
    stage.append(h('section', { class: 'card' }, h('h3', null, '2. Match the columns'),
      h('p', { class: 'muted pl-hint' }, `${parsed.rows.length} rows. Tell Fishtape which column is the part number and which is your cost.`),
      h('div', { class: 'form-grid' },
        colSelect('Part number (SKU)', 'sku'),
        colSelect('Description', 'description'),
        colSelect('Your cost', 'cost'),
        colSelect('List / sell (optional)', 'price'))));

    if (mapping.sku < 0 || mapping.cost < 0) { stage.append(h('p', { class: 'muted' }, 'Pick at least the part number and cost columns.')); return; }

    const plan = planUpdate({ rows: parsed.rows, mapping, items: store.list('items') });
    const sample = plan.matched.filter((m) => m.changed).slice(0, 8);
    const createBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: state.createMissing });
    createBox.addEventListener('change', () => { state.createMissing = createBox.checked; });
    const sellBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: state.updateSell });
    sellBox.addEventListener('change', () => { state.updateSell = sellBox.checked; });

    stage.append(h('section', { class: 'card' }, h('h3', null, '3. Preview'),
      h('p', { class: 'pl-summary' }, summarize(plan)),
      sample.length ? ui.table({
        columns: [
          { key: 'sku', label: 'Part #', render: (m) => m.sku },
          { key: 'name', label: 'Item', render: (m) => m.name || '—' },
          { key: 'old', label: 'Old cost', align: 'right', render: (m) => (m.oldCostCents == null ? '—' : money(m.oldCostCents)) },
          { key: 'new', label: 'New cost', align: 'right', render: (m) => money(m.costCents) },
        ],
        rows: sample,
      }) : h('p', { class: 'muted' }, 'No cost changes to existing items.'),
      h('label', { class: 'field check' }, sellBox, h('span', null, `Also set sell price from the file's list column${mapping.price < 0 ? ' (no list column mapped)' : ''}`)),
      h('label', { class: 'field check' }, createBox, h('span', null, `Create ${plan.unmatched.length} new item${plan.unmatched.length === 1 ? '' : 's'} for unmatched part numbers`)),
      h('div', { class: 'row' }, ui.button(`Apply to price book`, { variant: 'primary', icon: 'check', onClick: () => apply(plan) }))));
  }

  function apply(plan) {
    const today = ui.today();
    const supplier = state.supplier || null;
    let updated = 0; let created = 0;
    for (const m of plan.matched) {
      if (!m.changed && !supplier) continue;
      const patch = { costCents: m.costCents, lastCostUpdate: today };
      if (supplier) { patch.supplier = supplier; patch.supplierSku = m.sku; }
      if (state.updateSell && m.priceCents != null) patch.priceCents = m.priceCents;
      store.update('items', m.id, patch, { summary: `Price update${supplier ? ` from ${supplier}` : ''}` });
      updated++;
    }
    if (state.createMissing) {
      const markup = store.settings().markupPct || 0;
      for (const u of plan.unmatched) {
        store.add('items', {
          sku: u.sku, name: u.description || u.sku, category: 'Imported',
          costCents: u.costCents, priceCents: state.updateSell && u.priceCents != null ? u.priceCents : Math.round(u.costCents * (1 + markup / 100)),
          labourHours: 0, ...(supplier ? { supplier, supplierSku: u.sku } : {}), lastCostUpdate: today,
        });
        created++;
      }
    }
    ui.toast(`Updated ${updated} item${updated === 1 ? '' : 's'}${created ? `, created ${created}` : ''}.`, 'success', 5000);
    state.parsed = null; textarea.value = ''; drawStage();
  }

  root.append(ui.page({ title: 'Supplier price lists', subtitle: 'Import a distributor price file and update your price-book costs' }, stage));
  drawStage();
}
