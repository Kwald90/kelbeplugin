// Assembly estimating (#/assemblies): the company's reusable kits. An assembly is components
// (price-book items with quantities, material cost per unit) plus a labour value in hours. Count
// them on an estimate and they explode into a priced material line and a labour line.
//   #/assemblies            the library
//   #/assemblies/new        a new assembly
//   #/assemblies/:id        edit one
// Pure logic: js/lib/assemblies.js. Wired into the estimate builder (modules/estimates.js).
import { newAssembly, newComponent, materialUnitCents, labourUnitHours, unitSellCents, activeAssemblies, MAX_COMPONENTS } from '../lib/assemblies.js';
import { moneyFormatter } from '../lib/money.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/assemblies.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/assemblies.css';
  document.head.append(link);
}

export default {
  id: 'assemblies',
  title: 'Assemblies',
  icon: 'layers',
  group: 'money',
  perm: 'estimates',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { const a = ctx.store.add('assemblies', newAssembly({ by: ctx.store.actorId })); ctx.nav(`#/assemblies/${a.id}`); return; }
    if (sub) return editor(root, ctx, sub);
    return listView(root, ctx);
  },
};

// ---------- list ----------
function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const rate = store.settings().labourRateCents ?? 9500;
  const host = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(host);
    const all = activeAssemblies(store.list('assemblies')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    host.append(all.length ? ui.table({
      columns: [
        { key: 'name', label: 'Assembly', render: (a) => a.name || 'Untitled', sort: (a) => a.name || '' },
        { key: 'cat', label: 'Category', render: (a) => a.category || '—', sort: (a) => a.category || '' },
        { key: 'parts', label: 'Parts', align: 'right', render: (a) => (a.components || []).length },
        { key: 'mat', label: 'Material', align: 'right', render: (a) => money(materialUnitCents(a)), sort: (a) => materialUnitCents(a) },
        { key: 'hrs', label: 'Labour (h)', align: 'right', render: (a) => (labourUnitHours(a) || 0).toString() },
        { key: 'sell', label: 'Est. sell', align: 'right', render: (a) => money(unitSellCents(a, { labourRateCents: rate, markupPct: store.settings().markupPct || 0 }).totalCents), sort: (a) => unitSellCents(a, { labourRateCents: rate }).totalCents },
      ],
      rows: all, onRowClick: (a) => nav(`assemblies/${a.id}`),
    }) : ui.empty({ icon: 'layers', title: 'No assemblies yet', text: 'Build kits like "duplex receptacle" or "2x4 LED troffer" once — components plus the labour hours — then count them on an estimate instead of adding every part by hand.', action: ui.button('New assembly', { variant: 'primary', icon: 'plus', href: '#/assemblies/new' }) }));
  };

  root.append(ui.page({
    title: 'Assembly estimating', subtitle: 'Reusable kits of material and labour you count on a quote',
    actions: [ui.button('New assembly', { variant: 'primary', icon: 'plus', href: '#/assemblies/new' })],
  }, host));
  draw();
  return store.on('assemblies', draw);
}

// ---------- editor ----------
function editor(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const a = store.get('assemblies', id);
  if (!a) { ui.toast('That assembly is gone.', 'error'); nav('#/assemblies'); return; }
  const money = moneyFormatter(store.settings());
  const rate = store.settings().labourRateCents ?? 9500;
  const items = store.list('items').sort((x, y) => String(x.name).localeCompare(String(y.name)));
  a.components = a.components || [];

  const save = () => store.update('assemblies', id, { name: a.name, category: a.category, description: a.description, unit: a.unit, labourHours: a.labourHours, components: a.components });

  const totals = h('div', { class: 'asm-totals' });
  const drawTotals = () => {
    const s = unitSellCents(a, { labourRateCents: rate, markupPct: store.settings().markupPct || 0 });
    ui.clear(totals).append(
      ui.stat({ label: 'Material (cost)', value: money(materialUnitCents(a)) }),
      ui.stat({ label: 'Labour', value: `${labourUnitHours(a) || 0} h`, hint: money(s.labourCents) }),
      ui.stat({ label: 'Est. sell / unit', value: money(s.totalCents), hint: `at ${money(rate)}/h + markup` }));
  };

  const rowsHost = h('div', { class: 'asm-rows' });
  const drawRows = () => {
    ui.clear(rowsHost);
    a.components.forEach((c, i) => rowsHost.append(componentRow(c, i)));
    if (a.components.length < MAX_COMPONENTS) rowsHost.append(h('button', { type: 'button', class: 'asm-addrow', onClick: addRow }, ui.icon('plus', 16), 'Add component'));
  };

  function componentRow(c, i) {
    const pick = h('select', { class: 'input', 'aria-label': 'Price-book item' },
      h('option', { value: '' }, 'Custom (type below)'),
      items.map((it) => h('option', { value: it.id, selected: it.id === c.itemId }, `${it.name}${it.sku ? ` (${it.sku})` : ''}`)));
    pick.addEventListener('change', () => {
      const it = store.get('items', pick.value);
      if (it) { c.itemId = it.id; c.sku = it.sku || ''; c.description = it.name; c.unitCents = it.costCents ?? it.priceCents ?? 0; }
      else { c.itemId = null; }
      save(); drawRows(); drawTotals();
    });
    const desc = h('input', { class: 'input', value: c.description || '', placeholder: 'Component', 'aria-label': 'Description' });
    desc.addEventListener('input', () => { c.description = desc.value.slice(0, 300); clearTimeout(desc._t); desc._t = setTimeout(save, 500); });
    const qty = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: c.qty ?? 1, 'aria-label': 'Quantity' });
    qty.addEventListener('input', () => { c.qty = qty.value === '' ? 0 : Number(qty.value); clearTimeout(qty._t); qty._t = setTimeout(() => { save(); drawTotals(); }, 400); });
    const cost = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: c.unitCents == null ? '' : (c.unitCents / 100), 'aria-label': 'Unit cost' });
    cost.addEventListener('input', () => { c.unitCents = cost.value === '' ? 0 : Math.round(Number(cost.value) * 100); clearTimeout(cost._t); cost._t = setTimeout(() => { save(); drawTotals(); }, 400); });
    const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove', onClick: () => { a.components.splice(i, 1); save(); drawRows(); drawTotals(); } });
    return h('div', { class: 'asm-row' }, pick, desc, qty, cost, rm);
  }

  function addRow() { a.components.push(newComponent()); save(); drawRows(); }

  const fieldEl = (f, onVal) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); });
    return el;
  };

  const head = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Name', name: 'name', value: a.name, placeholder: 'Duplex receptacle, 15 A' }, (v) => { a.name = v; clearTimeout(head._t); head._t = setTimeout(save, 500); }),
    fieldEl({ label: 'Category', name: 'category', value: a.category, placeholder: 'Devices' }, (v) => { a.category = v; clearTimeout(head._c); head._c = setTimeout(save, 500); }),
    fieldEl({ label: 'Labour (hours per unit)', name: 'labourHours', type: 'number', step: '0.01', min: '0', value: a.labourHours ?? 0, hint: 'The labour unit — charged at your estimate labour rate' }, (v) => { a.labourHours = v || 0; save(); drawTotals(); }),
    fieldEl({ label: 'Unit', name: 'unit', value: a.unit || 'each', placeholder: 'each' }, (v) => { a.unit = v; clearTimeout(head._u); head._u = setTimeout(save, 500); }),
    fieldEl({ label: 'Notes', name: 'description', type: 'textarea', value: a.description, span: true }, (v) => { a.description = v; clearTimeout(head._d); head._d = setTimeout(save, 600); }));

  const remove = async () => {
    if (!(await ui.confirmDialog(`Delete the assembly "${a.name || 'Untitled'}"? Estimates already built from it keep their lines.`, { okLabel: 'Delete' }))) return;
    store.remove('assemblies', id); ui.toast('Assembly deleted'); nav('#/assemblies');
  };

  root.append(ui.page({
    title: a.name || 'New assembly',
    subtitle: h('span', null, ui.h('a', { href: '#/assemblies' }, 'Assemblies'), ' / ', a.name || 'Untitled'),
    actions: [ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete assembly', onClick: remove })],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Assembly'), head),
      h('section', { class: 'card' }, h('h3', null, 'Components (material cost per unit)'),
        h('p', { class: 'muted asm-hint' }, 'Pick price-book items or type custom parts. Enter material cost only — labour is charged separately from the hours above, and material markup is applied on the estimate.'),
        h('div', { class: 'asm-rowhead muted' }, h('span', null, 'Item'), h('span', null, 'Description'), h('span', { class: 'num' }, 'Qty'), h('span', { class: 'num' }, 'Unit $'), h('span', null, '')),
        rowsHost),
      h('section', { class: 'card' }, h('h3', null, 'Per unit'), totals),
      h('div', { class: 'row' }, ui.button('Back to assemblies', { variant: 'ghost', href: '#/assemblies' })))));

  drawRows();
  drawTotals();
}
