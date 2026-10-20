// Purchasing (#/purchasing): supplier bills and paid receipts (with a photo or PDF of the bill),
// supplier refunds as negative receipts, suppliers, and purchase orders, including POs made from
// the crew's material requests (modules/materials.js calls purchaseOrderSheet). Office only (the
// `invoices` permission): field crews never receive these records, so they never see a cost.
// Works with or without QuickBooks; when it is connected the sync sends bills, receipts and POs
// (docs/integrations/quickbooks.md 4.10), and a bill that doesn't add up waits until it does.
import {
  BILL_KINDS, KIND_LABEL, BILL_STATUS_LABEL, PO_STATUS_LABEL, PAID_WITH, PAID_WITH_LABEL, COST_TYPES, COST_TYPE_LABEL, TAX_IDS,
  RECEIPT_MAX_CHARS, RECEIPT_PHOTO_BYTES, MAX_LINES,
  vendorName, vendorActive, vendorChoices, vendorProblems, dueFromTerms,
  lineAmountCents, billTotals, isRefund, withSign, billStatusOf, billOutstanding, billProblems, suggestTaxes, newBill, enteredStatus,
  switchKind, newBillLine, editLine, receiptType, receiptProblem, purchasingAllowed,
  poLineCents, poTotalCents, poOpen, newPurchaseOrder, poProblems, poText, poBilled, billFromPo, orderableRequest, ordersFromRequests,
  purchasingSummary, billMatches, nextPoNumber, parsePoNumber, poLineLocked, removePoLine, requestAfterPoCancel,
  recordEditor, recordTooBig, tooBigMessage, blankBill, blankPurchaseOrder,
} from '../lib/purchasing.js';
import { moneyFormatter } from '../lib/money.js';
import { PROVINCES } from '../lib/tax.js';
import { pickItems } from '../lib/doc-view.js';
import { downscaleImage } from '../lib/safety-capture.js';
import { requestName, qtyText } from '../lib/materials.js';
import { qboBadge, allowedFor, qboStatusCache, connectionActive } from '../lib/qbo-ui.js';

// A shopping cart (icons.js has none).
const CART = '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.1a1 1 0 001 .9h9.7a1 1 0 001-.8L21 7H6"/>';

export default {
  id: 'purchasing',
  title: 'Purchasing',
  icon: CART,
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    ensureStyles();
    const [section, id] = ctx.params;
    if (section === 'bills' && id === 'new') { createBill(ctx); return; }
    if (section === 'bills' && id) return renderBill(root, ctx, id);
    if (section === 'vendors' && id) return renderVendor(root, ctx, id);
    if (section === 'vendors') return renderVendors(root, ctx);
    if (section === 'orders' && id === 'new') { createOrder(ctx); return; }
    if (section === 'orders' && id) return renderOrder(root, ctx, id);
    if (section === 'orders') return renderOrders(root, ctx);
    return renderBills(root, ctx);
  },
};

/**
 * The module's stylesheet. index.html links it; this covers an index.html cached before it did
 * (same origin, so the CSP and the service worker treat it alike).
 */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/purchasing.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/purchasing.css';
  document.head.append(link);
}

/** Can this person use purchasing here (role, Settings → Modules switch and plan)? */
export function canPurchase(ctx) {
  const { store, auth, app } = ctx;
  return purchasingAllowed({ canInvoices: auth.can('invoices'), settings: store.settings(), entitlements: auth.synced ? app?.session?.me?.entitlements || null : null });
}

// ---------- shared ----------

const SECTIONS = [
  { id: 'bills', label: 'Bills and receipts', href: '#/purchasing' },
  { id: 'orders', label: 'Purchase orders', href: '#/purchasing/orders' },
  { id: 'vendors', label: 'Suppliers', href: '#/purchasing/vendors' },
];
function subnav(ctx, active) {
  return ctx.ui.tabs(SECTIONS.map((s) => ({ id: s.id, label: s.label })), active, (id) => ctx.nav(SECTIONS.find((s) => s.id === id).href));
}

const vendorMap = (store) => new Map(store.list('vendors').map((v) => [v.id, v]));
const jobMap = (store) => new Map(store.list('jobs').map((j) => [j.id, j]));
const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const sortedJobs = (store) => store.list('jobs').sort((a, b) => String(b.number || '').localeCompare(String(a.number || ''), undefined, { numeric: true }));
const kindLabel = (b) => (isRefund(b) ? 'Refund' : b.kind === 'receipt' ? 'Receipt' : 'Bill');
const statusBadge = (ui, st, labels) => ui.badge(labels[st] || st, ui.STATUS_TONE[st] || 'neutral');
const billLabel = (b, vendors) => [vendorName(vendors.get(b.vendorId)), b.number].filter(Boolean).join(' ') || 'Bill';
const strip = ({ id, createdAt, updatedAt, ...rest }) => { void id; void createdAt; void updatedAt; return rest; };

/** A money <input> that may be blank (null). */
function moneyInput(ui, { name, value, label, onValue, placeholder = '', readonly = false }) {
  const input = ui.h('input', { class: 'input num', name, type: 'number', step: '0.01', inputmode: 'decimal', placeholder, readonly,
    value: value == null ? '' : ui.centsToInput(value), 'aria-label': label });
  input.addEventListener('input', () => onValue(input.value.trim() === '' ? null : ui.parseMoney(input.value)));
  return input;
}

/** Add or edit a supplier in a side sheet. Calls onSaved(record). */
export function vendorSheet(ctx, vendor, onSaved) {
  const { store, ui } = ctx;
  const v = vendor || {};
  ensureStyles();
  ui.formSheet({
    title: vendor ? `Edit ${vendorName(vendor)}` : 'New supplier',
    submitLabel: vendor ? 'Save' : 'Add supplier',
    fields: vendorFields(v),
    onSubmit: (vals) => {
      const rec = cleanVendor({ ...v, ...vals });
      const problems = vendorProblems(rec, store.list('vendors'));
      if (problems.length) { ui.toast(problems[0], 'error', 4000); return false; }
      const saved = vendor ? store.update('vendors', vendor.id, strip(rec), { summary: rec.name }) : store.add('vendors', rec);
      ui.toast(vendor ? 'Supplier saved' : `${saved.name} added`, 'success');
      onSaved?.(saved);
    },
  });
}

function vendorFields(v) {
  return [
    { label: 'Name', name: 'name', value: v.name || '', required: true, placeholder: 'e.g. Nedco Winnipeg' },
    { label: 'Company name', name: 'companyName', value: v.companyName || '' },
    { label: 'Email', name: 'email', type: 'email', value: v.email || '' },
    { label: 'Phone', name: 'phone', type: 'tel', value: v.phone || '' },
    { label: 'Address', name: 'address', type: 'textarea', rows: 2, value: v.address || '', span: true },
    { label: 'Your account number', name: 'accountNumber', value: v.accountNumber || '', hint: 'Your account with this supplier' },
    { label: 'Terms', name: 'terms', value: v.terms || '', placeholder: 'Net 30', hint: '"Net 30" sets a bill’s due date' },
    { label: 'Subcontractor on the T5018 slip', name: 't5018', type: 'checkbox', value: Boolean(v.t5018), span: true },
    { label: 'Active', name: 'active', type: 'checkbox', value: v.active !== false, span: true },
    { label: 'Notes', name: 'notes', type: 'textarea', rows: 3, value: v.notes || '', span: true },
  ];
}

function cleanVendor(v) {
  const out = { ...v };
  for (const k of ['name', 'companyName', 'email', 'phone', 'address', 'accountNumber', 'terms', 'notes']) out[k] = String(out[k] ?? '').trim();
  out.name = out.name.slice(0, 100); out.companyName = out.companyName.slice(0, 100);
  out.t5018 = Boolean(out.t5018);
  out.active = out.active !== false;
  return out;
}

/** <select> of suppliers with "New supplier…" at the end; onPick(vendorId) after a pick or an add. */
function vendorSelect(ctx, { value, onPick, name = 'vendorId', disabled = false }) {
  const { store, ui } = ctx;
  const { h } = ui;
  const sel = h('select', { name, disabled, 'aria-label': 'Supplier' });
  const fill = (cur) => {
    ui.clear(sel).append(h('option', { value: '' }, '— pick a supplier —'),
      ...vendorChoices(store.list('vendors'), cur).map((v) => h('option', { value: v.id, selected: v.id === cur }, vendorName(v) + (vendorActive(v) ? '' : ' (inactive)'))),
      h('option', { value: '__new' }, 'New supplier…'));
    sel.value = cur || '';
  };
  fill(value);
  sel.addEventListener('change', () => {
    if (sel.value !== '__new') { onPick(sel.value || null); return; }
    const prev = value;
    sel.value = prev || '';
    vendorSheet(ctx, null, (v) => { value = v.id; fill(v.id); onPick(v.id); });
  });
  return sel;
}

// ---------- bills and receipts: list ----------

const BILL_TABS = [
  { id: 'all', label: 'All' }, { id: 'open', label: 'To pay' }, { id: 'overdue', label: 'Overdue' },
  { id: 'receipt', label: 'Receipts' }, { id: 'draft', label: 'Drafts' }, { id: 'paid', label: 'Paid' }, { id: 'void', label: 'Void' },
];
function inBillTab(tab, b, today) {
  const st = billStatusOf(b, today);
  if (tab === 'all') return true;
  if (tab === 'open') return billOutstanding(b);
  if (tab === 'overdue') return st === 'overdue';
  if (tab === 'receipt') return b.kind === 'receipt' && b.status !== 'void';
  return b.status === tab;
}

function renderBills(root, ctx) {
  const { store, ui, nav, query } = ctx;
  const { h } = ui;
  let tab = BILL_TABS.some((t) => t.id === query.tab) ? query.tab : 'all';
  let q = '';
  const host = h('div', { class: 'stack' });
  const tableHost = h('div');
  const money = moneyFormatter(store.settings());

  const draw = () => {
    ui.clear(host);
    const today = ui.today();
    const all = store.list('bills', null, { omit: ['receipt'] });
    const sum = purchasingSummary(all, today);
    const counts = Object.fromEntries(BILL_TABS.map((t) => [t.id, all.filter((b) => inBillTab(t.id, b, today)).length]));
    h(host, null,
      h('div', { class: 'grid money-stats' },
        ui.stat({ label: 'To pay', value: money(sum.toPayCents, { whole: true }), hint: `${sum.toPay} bill${sum.toPay === 1 ? '' : 's'}`, tone: 'accent' }),
        ui.stat({ label: 'Overdue', value: money(sum.overdueCents, { whole: true }), hint: `${sum.overdue} past due`, tone: sum.overdue ? 'danger' : null }),
        ui.stat({ label: 'Spent this month', value: money(sum.monthCents, { whole: true }), hint: 'Bills and receipts, refunds netted off' })),
      h('div', { class: 'row' },
        ui.tabs(BILL_TABS.map((t) => ({ id: t.id, label: t.id === 'all' ? `All ${counts.all}` : `${t.label}${counts[t.id] ? ` ${counts[t.id]}` : ''}` })), tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }),
        ui.searchBox('Search supplier, number, job', (v) => { q = v; drawTable(); }, q)),
      tableHost);
    drawTable();

    function drawTable() {
      const vendors = vendorMap(store), jobs = jobMap(store);
      const rows = all.filter((b) => inBillTab(tab, b, today) && billMatches(b, q, { vendors, jobs }))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt).localeCompare(String(a.createdAt)));
      ui.clear(tableHost).append(ui.table({
        columns: [
          { key: 'date', label: 'Date', render: (b) => ui.fmtDate(b.date), sort: (b) => b.date || '' },
          { key: 'vendor', label: 'Supplier', render: (b) => vendorName(vendors.get(b.vendorId)), sort: (b) => vendorName(vendors.get(b.vendorId)) },
          { key: 'number', label: 'Number', render: (b) => h('span', { class: 'mono' }, b.number || '—'), sort: (b) => b.number || '' },
          { key: 'kind', label: 'Kind', render: (b) => kindLabel(b), sort: (b) => kindLabel(b) },
          { key: 'job', label: 'Job', render: (b) => (b.jobId ? jobs.get(b.jobId)?.number || '—' : '—'), sort: (b) => jobs.get(b.jobId)?.number || '' },
          { key: 'due', label: 'Due', render: (b) => (b.kind === 'bill' ? ui.fmtDate(b.dueDate) : '—'), sort: (b) => b.dueDate || '' },
          { key: 'total', label: 'Total', align: 'right', render: (b) => money(billTotals(b).totalCents), sort: (b) => billTotals(b).totalCents },
          { key: 'status', label: 'Status', render: (b) => h('span', { class: 'pu-status' }, statusBadge(ui, billStatusOf(b, today), BILL_STATUS_LABEL),
            billTotals(b).mismatch ? ui.badge("Doesn't add up", 'warning') : null, qboBadge(ctx, 'bills', b.id, { record: b })), sort: (b) => billStatusOf(b, today) },
        ],
        rows,
        onRowClick: (b) => nav('#/purchasing/bills/' + b.id),
        empty: ui.empty({ icon: CART, title: all.length ? 'Nothing here' : 'No bills or receipts yet',
          text: all.length ? 'Try another tab or search.' : 'Enter supplier bills to pay later, and receipts for what was paid on the spot. Snap a photo of each one.',
          action: all.length ? null : ui.button('New bill', { variant: 'primary', icon: 'plus', href: '#/purchasing/bills/new' }) }),
      }));
    }
  };

  root.append(ui.page({
    title: 'Purchasing', subtitle: 'Supplier bills, receipts and purchase orders',
    actions: [
      ui.button('New receipt', { icon: 'receipt', href: '#/purchasing/bills/new?kind=receipt' }),
      ui.button('New bill', { variant: 'primary', icon: 'plus', href: '#/purchasing/bills/new' }),
    ],
  }, subnav(ctx, 'bills'), host));
  draw();
  const offs = ['bills', 'vendors'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

function createBill(ctx) {
  const { store, ui, query } = ctx;
  const kind = query.kind === 'receipt' ? 'receipt' : 'bill';
  const po = query.poId ? store.get('purchaseOrders', query.poId) : null;
  const rec = po
    ? billFromPo(po, { bills: store.list('bills', null, { omit: ['receipt'] }), settings: store.settings(), today: ui.today() })
    : newBill({ kind, settings: store.settings(), today: ui.today(), vendorId: query.vendorId || null, jobId: query.jobId || null });
  if (!po && rec.vendorId && rec.kind === 'bill') rec.dueDate = dueFromTerms(store.get('vendors', rec.vendorId)?.terms, rec.date) || rec.dueDate;
  const created = store.add('bills', rec);
  // fresh: backing out before filling anything in deletes it again (renderBill).
  location.replace('#/purchasing/bills/' + created.id + (po ? '' : '?fresh=1'));
}

/** A shared "too big to sync" toast, at most every few seconds while the user keeps typing. */
function tooBigToast(ui, coll) {
  let last = 0;
  return () => { if (Date.now() - last > 8000) { last = Date.now(); ui.toast(tooBigMessage(coll), 'error', 6000); } };
}

// ---------- bills and receipts: one ----------

function renderBill(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const found = store.get('bills', id);
  if (!found) {
    root.append(ui.page({ title: 'Bill not found' }, ui.empty({ icon: CART, title: 'This bill no longer exists', action: ui.button('Purchasing', { href: '#/purchasing' }) })));
    return;
  }
  const doc = found;
  doc.lines = Array.isArray(doc.lines) ? doc.lines : [];
  doc.taxes = Array.isArray(doc.taxes) ? doc.taxes : [];
  const money = moneyFormatter(store.settings());
  let refund = isRefund(doc);
  const sign = () => (doc.kind === 'receipt' && refund ? -1 : 1);
  const readOnly = () => doc.status === 'void';
  // Saves only the fields typed into; status and kind go through setStatus and the kind switch, and
  // a status that changes elsewhere (QuickBooks marks it paid, another office user voids it) is
  // taken in here rather than written back over.
  let wasReadOnly = readOnly();
  const ed = recordEditor(store, 'bills', id, doc, {
    summary: () => billLabel(doc, vendorMap(store)),
    onTooBig: tooBigToast(ui, 'bills'),
    onPulled: (fields) => {
      if (fields.includes('kind') || readOnly() !== wasReadOnly) drawAll();
      else { drawTitle(); drawStatus(); }
    },
    onRemoved: () => { ui.toast('This bill was deleted on another device', 'info', 4000); nav('#/purchasing'); },
  });
  const changed = (...fields) => { ed.touch(...fields); drawTotals(); drawStatus(); };
  const title = () => (doc.number ? `${kindLabel(doc)} ${doc.number}` : `New ${kindLabel(doc).toLowerCase()}`);
  const drawTitle = () => { const t = root.querySelector('.page-head h1'); if (t) t.textContent = title(); };

  // ---- header ----
  const headerHost = h('div');
  const drawHeader = () => {
    const jobs = sortedJobs(store);
    const field = (label, control, span) => h('label', { class: ['field', span ? 'span-2' : null] }, h('span', null, label), control);
    // Each control saves the field it is named for.
    const input = (name, type, value, onVal, extra = {}) => {
      const el = h('input', { name, type, value: value ?? '', readonly: readOnly(), ...extra });
      el.addEventListener(type === 'date' ? 'change' : 'input', () => { onVal(el.value); changed(name); });
      return el;
    };
    const select = (name, value, options, onVal) => {
      const el = h('select', { name, disabled: readOnly() }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
      el.addEventListener('change', () => { onVal(el.value); changed(name); });
      return el;
    };
    // The kind switch saves at once, on its own (it sets the status too).
    const kind = h('select', { name: 'kind', disabled: readOnly() }, BILL_KINDS.map((k) => h('option', { value: k, selected: k === doc.kind }, KIND_LABEL[k])));
    kind.addEventListener('change', () => {
      const patch = switchKind(doc, kind.value);
      if (!Object.keys(patch).length) return;
      ed.write(patch, { summary: `${billLabel(doc, vendorMap(store))} → ${doc.kind === 'receipt' ? 'bill' : 'receipt'}` });
      if (doc.kind !== 'receipt') refund = false;
      drawAll();
    });
    const vendor = vendorSelect(ctx, { value: doc.vendorId, disabled: readOnly(), onPick: (v) => {
      doc.vendorId = v;
      const due = doc.kind === 'bill' && doc.status === 'draft' ? dueFromTerms(store.get('vendors', v)?.terms, doc.date) : null;
      if (due) doc.dueDate = due;
      drawHeader();
      changed('vendorId', 'dueDate');
    } });
    // QuickBooks links a bill only to its own supplier's orders.
    const pos = store.list('purchaseOrders').filter((p) => p.id === doc.purchaseOrderId || (p.status !== 'cancelled' && (!doc.vendorId || p.vendorId === doc.vendorId)));
    const total = moneyInput(ui, { name: 'totalCents', label: 'Total on the bill', value: doc.totalCents == null ? null : Math.abs(doc.totalCents), placeholder: 'as printed', readonly: readOnly(),
      onValue: (c) => { doc.totalCents = c == null ? null : sign() * Math.abs(c); changed('totalCents'); } });
    ui.clear(headerHost).append(h('div', { class: 'form-grid' },
      field('Kind', kind),
      field('Supplier', vendor),
      field(doc.kind === 'receipt' ? 'Receipt number' : 'Supplier’s invoice number', input('number', 'text', doc.number, (v) => { doc.number = v.slice(0, 40); drawTitle(); }, { maxlength: '40' })),
      field('Date', input('date', 'date', doc.date, (v) => { doc.date = v || null; })),
      doc.kind === 'bill'
        ? field('Due date', input('dueDate', 'date', doc.dueDate, (v) => { doc.dueDate = v || null; }))
        : field('Paid with', select('paidWith', doc.paidWith || 'card', PAID_WITH.map((p) => ({ value: p, label: PAID_WITH_LABEL[p] })), (v) => { doc.paidWith = v; })),
      field('Job', select('jobId', doc.jobId || '', [{ value: '', label: '— no job (overhead) —' }, ...jobs.map((j) => ({ value: j.id, label: jobLabel(j) }))], (v) => { doc.jobId = v || null; })),
      field('Purchase order', select('purchaseOrderId', doc.purchaseOrderId || '', [{ value: '', label: '— none —' }, ...pos.map((p) => ({ value: p.id, label: `${p.number}${p.vendorId !== doc.vendorId ? ` · ${vendorName(store.get('vendors', p.vendorId))}` : ''}` }))], (v) => {
        doc.purchaseOrderId = v || null;
        // No supplier yet: the order's supplier it is.
        const p = v ? store.get('purchaseOrders', v) : null;
        if (p?.vendorId && !doc.vendorId) { doc.vendorId = p.vendorId; ed.touch('vendorId'); drawHeader(); }
      })),
      field('Tax province', select('taxProvince', doc.taxProvince || store.settings().company?.province || 'ON', PROVINCES.map((p) => ({ value: p.code, label: p.name })), (v) => { doc.taxProvince = v; })),
      field('Total on the bill', total),
      doc.kind === 'receipt'
        ? h('label', { class: 'field check span-2' }, h('input', { type: 'checkbox', name: 'refund', checked: refund, disabled: readOnly(), onChange: (e) => {
          refund = e.target.checked;
          Object.assign(doc, withSign(doc, refund ? -1 : 1));
          drawTitle(); drawHeader(); drawLines(); drawTaxes(); changed('lines', 'taxes', 'totalCents');
        } }), h('span', null, 'Refund or credit from the supplier (money back)'))
        : null));
  };

  // ---- lines ----
  const linesHost = h('div', { class: 'lines pu-lines' });
  const drawLines = () => {
    ui.clear(linesHost);
    const jobs = sortedJobs(store);
    if (!doc.lines.length) linesHost.append(h('div', { class: 'lines-empty muted' }, 'No lines yet. Copy them from the bill: what you bought, how many, and the cost.'));
    doc.lines.forEach((l, i) => {
      const amount = moneyInput(ui, { name: 'amountCents', label: `Line ${i + 1} amount`, value: Math.abs(lineAmountCents(l)), readonly: readOnly(), onValue: (c) => set({ amountCents: sign() * Math.abs(c || 0) }) });
      const set = (patch) => {
        doc.lines[i] = editLine(doc.lines[i], patch);
        if ('qty' in patch || 'unitCents' in patch) amount.value = ui.centsToInput(Math.abs(lineAmountCents(doc.lines[i])));
        changed('lines');
      };
      const desc = h('input', { class: 'input', name: 'description', value: l.description || '', placeholder: 'What was bought', maxlength: '4000', readonly: readOnly(), 'aria-label': `Line ${i + 1} description` });
      desc.addEventListener('input', () => set({ description: desc.value }));
      const qty = h('input', { class: 'input num', name: 'qty', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.qty ?? 1, readonly: readOnly(), 'aria-label': `Line ${i + 1} quantity` });
      qty.addEventListener('input', () => set({ qty: Number(qty.value) || 0 }));
      const unit = moneyInput(ui, { name: 'unitCents', label: `Line ${i + 1} unit cost`, value: Math.abs(Number(l.unitCents) || 0), readonly: readOnly(), onValue: (c) => set({ unitCents: sign() * Math.abs(c || 0) }) });
      const cost = h('select', { name: 'costType', class: 'line-kind', disabled: readOnly(), 'aria-label': `Line ${i + 1} cost type` }, COST_TYPES.map((c) => h('option', { value: c, selected: (l.costType || 'material') === c }, COST_TYPE_LABEL[c])));
      cost.addEventListener('change', () => set({ costType: cost.value }));
      const job = h('select', { name: 'lineJobId', class: 'line-kind', disabled: readOnly(), 'aria-label': `Line ${i + 1} job` },
        h('option', { value: '' }, doc.jobId ? 'Bill’s job' : 'No job'), jobs.map((j) => h('option', { value: j.id, selected: l.jobId === j.id }, j.number || j.title)));
      job.addEventListener('change', () => set({ jobId: job.value || null }));
      const po = l.poLine?.purchaseOrderId ? store.get('purchaseOrders', l.poLine.purchaseOrderId) : null;
      linesHost.append(h('div', { class: 'line-row pu-line', dataset: { line: String(i) } },
        h('div', { class: 'line-desc' }, desc, h('div', { class: 'line-meta' }, cost, job,
          l.itemId ? h('span', { class: 'muted' }, 'price book') : null,
          po ? h('a', { class: 'muted', href: '#/purchasing/orders/' + po.id }, `${po.number} line ${l.poLine.index + 1}`) : null)),
        h('label', { class: 'line-qty' }, h('span', { class: 'line-label' }, 'Qty'), qty),
        h('label', { class: 'line-unit' }, h('span', { class: 'line-label' }, 'Unit cost'), unit),
        h('label', { class: 'line-amt' }, h('span', { class: 'line-label' }, 'Amount'), amount),
        readOnly() ? h('div') : h('div', { class: 'line-actions' }, ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: `Remove line ${i + 1}`, onClick: () => { doc.lines.splice(i, 1); drawLines(); changed('lines'); } }))));
    });
    if (readOnly()) return;
    const full = doc.lines.length >= MAX_LINES;
    linesHost.append(h('div', { class: 'row lines-add' },
      ui.button('Add line', { size: 'sm', icon: 'plus', disabled: full, onClick: () => { doc.lines.push(newBillLine({ jobId: null })); drawLines(); changed('lines'); [...linesHost.querySelectorAll('.pu-line input[name=description]')].at(-1)?.focus(); } }),
      ui.button('From the price book', { size: 'sm', icon: 'box', disabled: full, onClick: () => pickItems(store, (it) => {
        if (doc.lines.length >= MAX_LINES) return;
        const unitCents = sign() * Math.abs(Number(it.costCents) || 0);
        doc.lines.push(newBillLine({ description: it.name, itemId: it.id, unitCents, amountCents: unitCents }));
        drawLines(); changed('lines');
      }) })));
  };

  // ---- taxes ----
  const taxesHost = h('div', { class: 'stack pu-taxes' });
  const drawTaxes = () => {
    ui.clear(taxesHost);
    doc.taxes.forEach((t, i) => {
      const id = h('select', { name: 'taxId', disabled: readOnly(), 'aria-label': `Tax ${i + 1}` }, TAX_IDS.map((x) => h('option', { value: x, selected: t.id === x }, x)));
      id.addEventListener('change', () => { doc.taxes[i] = { ...doc.taxes[i], id: id.value, label: id.value }; changed('taxes'); });
      const cents = moneyInput(ui, { name: 'taxCents', label: `Tax ${i + 1} amount`, value: Math.abs(Number(t.cents) || 0), readonly: readOnly(), onValue: (c) => { doc.taxes[i] = { ...doc.taxes[i], cents: sign() * Math.abs(c || 0) }; changed('taxes'); } });
      taxesHost.append(h('div', { class: 'pu-tax-row', dataset: { tax: String(i) } }, id, cents,
        readOnly() ? null : ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'x', title: `Remove tax ${i + 1}`, onClick: () => { doc.taxes.splice(i, 1); drawTaxes(); changed('taxes'); } })));
    });
    if (!doc.taxes.length) taxesHost.append(h('p', { class: 'muted pu-note' }, 'No tax on this bill.'));
    if (readOnly()) return;
    taxesHost.append(h('div', { class: 'row' },
      ui.button('Add tax', { size: 'sm', icon: 'plus', disabled: doc.taxes.length >= 4, onClick: () => { const used = new Set(doc.taxes.map((t) => t.id)); const next = TAX_IDS.find((x) => !used.has(x)) || 'GST'; doc.taxes.push({ id: next, label: next, cents: 0 }); drawTaxes(); changed('taxes'); } }),
      ui.button(`Work out (${doc.taxProvince || store.settings().company?.province || 'ON'})`, { size: 'sm', variant: 'ghost', title: 'Fill in the province’s rates on the lines; check them against the bill', onClick: () => {
        const prov = doc.taxProvince || store.settings().company?.province || 'ON';
        doc.taxes = suggestTaxes(prov, doc.date || ui.today(), billTotals({ lines: doc.lines }).linesCents);
        drawTaxes(); changed('taxes');
      } })),
      h('p', { class: 'muted pu-note' }, 'Enter the taxes exactly as printed on the bill.'));
  };

  // ---- totals ----
  const totalsHost = h('div', { class: 'totals' });
  const drawTotals = () => {
    const t = billTotals(doc);
    const row = (label, v, cls) => h('div', { class: ['totals-row', cls] }, h('span', null, label), h('span', { class: 'num' }, v));
    h(ui.clear(totalsHost), null,
      row('Lines', money(t.linesCents)),
      ...doc.taxes.map((x) => row(x.label || x.id, money(Number(x.cents) || 0))),
      row('Adds up to', money(t.computedCents), 'strong'),
      t.typed ? row('Total on the bill', money(t.totalCents), 'grand') : row('Total', money(t.totalCents), 'grand'),
      t.typed && t.diffCents ? row('Difference', money(t.diffCents), t.mismatch ? 'pu-diff bad' : 'pu-diff') : null,
      t.mismatch ? h('div', { class: 'pu-mismatch', role: 'status', dataset: { mismatch: '1' } }, ui.icon('alert', 16),
        h('div', null, h('strong', null, 'Bill total doesn’t add up'),
          h('div', null, 'It is saved, but it won’t go to QuickBooks until the lines and taxes match the printed total (within 2 cents).'),
          readOnly() ? null : ui.button(`Use ${money(t.computedCents)} as the total`, { size: 'sm', variant: 'ghost', onClick: () => { doc.totalCents = t.computedCents; drawHeader(); changed('totalCents'); } })))
        : null);
  };

  // ---- status ----
  const statusHost = h('div', { class: 'stack' });
  // With QuickBooks connected a bill's paid status comes only from QuickBooks (4.10): no Mark paid.
  let qboPaid = false;
  if (allowedFor(ctx)) qboStatusCache.status().then((s) => { if (connectionActive(s)) { qboPaid = true; drawStatus(); } }).catch(() => {});
  const setStatus = (status, extra = {}) => {
    ed.write({ status, ...extra }, { summary: `${billLabel(doc, vendorMap(store))} → ${status}` });
    drawAll();
  };
  const drawStatus = () => {
    const st = billStatusOf(doc, ui.today());
    const problems = billProblems(doc, { money, po: doc.purchaseOrderId ? store.get('purchaseOrders', doc.purchaseOrderId) : null });
    const blocking = problems.filter((p) => p.block);
    const enter = () => {
      if (blocking.length) { ui.toast(blocking[0].message, 'error', 4000); return; }
      setStatus(enteredStatus(doc));
      ui.toast(doc.kind === 'receipt' ? 'Receipt saved' : 'Bill entered: it is on the To pay list', 'success');
    };
    h(ui.clear(statusHost), null,
      h('div', { class: 'row' }, h('strong', null, 'Status'), h('span', { class: 'grow' }), qboBadge(ctx, 'bills', id, { record: doc }), statusBadge(ui, st, BILL_STATUS_LABEL)),
      problems.length && doc.status !== 'void' ? h('ul', { class: 'pu-problems' }, problems.map((p) => h('li', { class: p.block ? 'block' : 'warn', dataset: { problem: p.code } }, p.message))) : null,
      h('div', { class: 'row pu-actions' },
        doc.status === 'draft' ? ui.button(doc.kind === 'receipt' ? 'Save receipt' : 'Enter bill', { size: 'sm', variant: 'primary', icon: 'check', onClick: enter }) : null,
        doc.kind === 'bill' && doc.status === 'open' && !qboPaid ? ui.button('Mark paid', { size: 'sm', icon: 'dollar', onClick: () => { setStatus('paid'); ui.toast('Marked paid', 'success'); } }) : null,
        doc.kind === 'bill' && doc.status === 'paid' && !qboPaid ? ui.button('Mark unpaid', { size: 'sm', onClick: () => setStatus('open') }) : null,
        doc.status !== 'void' && doc.status !== 'draft' ? ui.button('Void', { size: 'sm', variant: 'ghost danger', onClick: async () => {
          if (!(await ui.confirmDialog(`Void this ${doc.kind}? It stays on record but no longer counts.`, { okLabel: 'Void' }))) return;
          setStatus('void');
        } }) : null,
        doc.status === 'void' ? ui.button('Restore', { size: 'sm', onClick: () => setStatus('draft') }) : null),
      doc.kind === 'bill' && ['open', 'paid'].includes(doc.status) ? h('p', { class: 'muted pu-note', dataset: qboPaid ? { qboPaid: '1' } : {} }, qboPaid
        ? 'Pay this bill in QuickBooks: it is marked paid here when the payment comes back.'
        : 'With QuickBooks connected, paying the bill there marks it paid here.') : null,
      doc.purchaseOrderId && store.get('purchaseOrders', doc.purchaseOrderId) ? ui.button(`Purchase order ${store.get('purchaseOrders', doc.purchaseOrderId).number}`, { size: 'sm', variant: 'ghost', icon: 'file-text', href: '#/purchasing/orders/' + doc.purchaseOrderId }) : null,
      doc.jobId ? ui.button('Open job', { size: 'sm', variant: 'ghost', icon: 'briefcase', href: '#/jobs/' + doc.jobId }) : null,
      (doc.materialRequestIds || []).length ? h('a', { class: 'muted', href: '#/materials' }, `Covers ${doc.materialRequestIds.length} material request${doc.materialRequestIds.length === 1 ? '' : 's'}`) : null);
  };

  // ---- the bill itself: photo or PDF ----
  const receiptHost = h('div', { class: 'stack' });
  const attach = (receipt) => {
    const problem = receiptProblem(receipt);
    if (problem) { ui.toast(problem, 'error', 4500); return; }
    if (recordTooBig('bills', { ...store.get('bills', id), ...doc, receipt })) { ui.toast(tooBigMessage('bills'), 'error', 6000); return; }
    doc.receipt = receipt;
    ed.touch('receipt'); ed.flush();
    drawReceipt();
    ui.toast('Attached', 'success');
  };
  const fromFile = async (file) => {
    if (!file) return;
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        if (file.size > RECEIPT_MAX_CHARS * 0.74) { ui.toast('That PDF is too big. Attach one under about 1.8 MB, or a photo of the bill.', 'error', 4500); return; }
        const dataUrl = await readAsDataUrl(file);
        attach({ dataUrl: dataUrl.replace(/^data:[^;,]*/, 'data:application/pdf'), name: file.name.slice(0, 200), takenAt: new Date().toISOString() });
      } else {
        const p = await downscaleImage(file, RECEIPT_PHOTO_BYTES);
        attach({ dataUrl: p.dataUrl, name: (file.name || 'photo.jpg').slice(0, 200), takenAt: new Date().toISOString() });
      }
    } catch (e) {
      console.error(e);
      ui.toast('Couldn’t read that file', 'error');
    }
  };
  const drawReceipt = () => {
    ui.clear(receiptHost).append(h('h3', null, doc.kind === 'receipt' ? 'The receipt' : 'The bill'));
    const r = doc.receipt;
    const type = r ? receiptType(r.dataUrl) : null;
    if (type === 'application/pdf') {
      receiptHost.append(h('div', { class: 'pu-receipt pdf', dataset: { receipt: 'pdf' } }, ui.icon('file-text', 28),
        h('div', { class: 'grow' }, h('div', null, r.name || 'Bill.pdf'), h('div', { class: 'muted' }, ui.fmtDateTime(r.takenAt))),
        ui.button('Download', { size: 'sm', icon: 'download', onClick: () => ui.download(r.name || 'bill.pdf', dataUrlBlob(r.dataUrl), 'application/pdf') })));
    } else if (type) {
      receiptHost.append(h('figure', { class: 'pu-receipt', dataset: { receipt: 'image' } }, h('img', { src: r.dataUrl, alt: `Photo of the ${doc.kind}` }),
        h('figcaption', { class: 'muted' }, ui.fmtDateTime(r.takenAt))));
    } else {
      receiptHost.append(h('p', { class: 'muted pu-note' }, 'No photo yet. Keep the bill with its record: snap it, or attach the supplier’s PDF.'));
    }
    if (readOnly()) return;
    receiptHost.append(h('div', { class: 'row' },
      ui.button(r ? 'Retake photo' : 'Take photo', { size: 'sm', icon: 'image', onClick: () => pickCapture().then(fromFile) }),
      ui.button('Attach file', { size: 'sm', icon: 'upload', onClick: () => ui.pickFile('image/jpeg,image/png,application/pdf').then(fromFile) }),
      r ? ui.button('Remove', { size: 'sm', variant: 'ghost danger', onClick: async () => {
        if (!(await ui.confirmDialog('Remove the attached photo or PDF?', { okLabel: 'Remove' }))) return;
        doc.receipt = null; ed.touch('receipt'); ed.flush(); drawReceipt();
      } }) : null));
  };

  const remove = async () => {
    if (!(await ui.confirmDialog(`Delete this ${doc.kind}? Voiding keeps a record; deleting doesn’t.`, { okLabel: 'Delete' }))) return;
    ed.stop();
    store.remove('bills', id);
    ui.toast('Deleted');
    nav('#/purchasing');
  };

  // ---- void banner and notes (read-only follows the status) ----
  const voidHost = h('div');
  const drawVoid = () => {
    ui.clear(voidHost);
    if (readOnly()) voidHost.append(h('div', { class: 'card money-void' }, ui.badge('void', 'neutral'), ' Void and read-only. Restore it to change it.'));
  };
  const notesHost = h('div', { class: 'card' });
  const drawNotes = () => {
    const t = h('textarea', { name: 'notes', rows: 3, maxlength: '2000', readonly: readOnly() }, doc.notes || '');
    t.addEventListener('input', () => { doc.notes = t.value; changed('notes'); });
    ui.clear(notesHost).append(h('label', { class: 'field' }, h('span', null, 'Notes (office only)'), t));
  };
  const drawAll = () => {
    wasReadOnly = readOnly();
    drawTitle(); drawVoid(); drawHeader(); drawLines(); drawTaxes(); drawNotes(); drawTotals(); drawStatus(); drawReceipt();
  };

  drawAll();
  const vendors = vendorMap(store);
  root.append(ui.page({
    title: title(),
    subtitle: h('span', null, h('a', { href: '#/purchasing' }, 'Purchasing'), ' / ', vendorName(vendors.get(doc.vendorId))),
    actions: [ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete', onClick: remove })],
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      voidHost,
      h('div', { class: 'card' }, headerHost),
      h('div', { class: 'card' }, h('h3', null, 'Lines'), linesHost),
      h('div', { class: 'card' }, h('h3', null, 'Taxes'), taxesHost),
      notesHost),
    h('aside', { class: 'doc-side stack' },
      h('div', { class: 'card' }, statusHost),
      h('div', { class: 'card' }, h('h3', null, 'Totals'), totalsHost),
      h('div', { class: 'card' }, receiptHost)))));
  return () => {
    ed.stop();
    // "New bill" and straight back out: nothing was filled in, so nothing is kept.
    if (ctx.query.fresh && blankBill(store.get('bills', id))) store.remove('bills', id);
  };
}

/** Open the camera (rear camera on phones and iPads) for one photo. Resolves a File or null. */
function pickCapture() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.className = 'pu-file';
    let settled = false;
    const done = (f) => { if (settled) return; settled = true; input.remove(); resolve(f || null); };
    input.addEventListener('change', () => done(input.files?.[0]));
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function dataUrlBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const type = /^data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ---------- suppliers ----------

function renderVendors(root, ctx) {
  const { store, ui, nav, query } = ctx;
  const { h } = ui;
  let q = '', showInactive = false;
  const host = h('div');
  const money = moneyFormatter(store.settings());
  const draw = () => {
    ui.clear(host);
    const bills = store.list('bills', null, { omit: ['receipt'] });
    const owed = new Map();
    for (const b of bills) if (billOutstanding(b)) owed.set(b.vendorId, (owed.get(b.vendorId) || 0) + billTotals(b).totalCents);
    const n = q.trim().toLowerCase();
    const all = store.list('vendors');
    const rows = all.filter((v) => (showInactive || vendorActive(v)) && (!n || [v.name, v.companyName, v.email, v.phone, v.accountNumber].some((s) => String(s || '').toLowerCase().includes(n))))
      .sort((a, b) => vendorName(a).localeCompare(vendorName(b)));
    host.append(
      ui.table({
        columns: [
          { key: 'name', label: 'Supplier', render: (v) => h('span', { class: 'row-inline' }, vendorName(v), vendorActive(v) ? null : h('span', { class: 'muted' }, ' (inactive)'), qboBadge(ctx, 'vendors', v.id, { record: v })), sort: (v) => vendorName(v) },
          { key: 'phone', label: 'Phone', render: (v) => v.phone || '—' },
          { key: 'email', label: 'Email', render: (v) => v.email || '—' },
          { key: 'acct', label: 'Account', render: (v) => v.accountNumber || '—' },
          { key: 'owed', label: 'To pay', align: 'right', render: (v) => (owed.get(v.id) ? money(owed.get(v.id)) : '—'), sort: (v) => owed.get(v.id) || 0 },
        ],
        rows,
        onRowClick: (v) => nav('#/purchasing/vendors/' + v.id),
        empty: ui.empty({ icon: 'users', title: all.length ? 'No match' : 'No suppliers yet', text: all.length ? 'Try another search.' : 'Add the wholesalers and subcontractors you buy from.',
          action: all.length ? null : ui.button('New supplier', { variant: 'primary', icon: 'plus', onClick: () => vendorSheet(ctx, null, (v) => nav('#/purchasing/vendors/' + v.id)) }) }),
      }));
  };
  root.append(ui.page({ title: 'Purchasing', subtitle: 'Suppliers and subcontractors',
    actions: [ui.button('New supplier', { variant: 'primary', icon: 'plus', onClick: () => vendorSheet(ctx, null, (v) => nav('#/purchasing/vendors/' + v.id)) })] },
  subnav(ctx, 'vendors'),
  h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('label', { class: 'field check' }, h('input', { type: 'checkbox', name: 'showInactive', checked: showInactive, onChange: (e) => { showInactive = e.target.checked; draw(); } }), h('span', null, 'Show inactive')),
      h('span', { class: 'grow' }),
      ui.searchBox('Search suppliers', (v) => { q = v; draw(); }, q)),
    host)));
  draw();
  if (query.new) setTimeout(() => vendorSheet(ctx, null, (v) => nav('#/purchasing/vendors/' + v.id)), 30);
  const offs = ['vendors', 'bills'].map((c) => store.on(c, () => { if (!document.querySelector('.sheet, .dialog')) draw(); }));
  return () => offs.forEach((f) => f());
}

function renderVendor(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const v = store.get('vendors', id);
  if (!v) {
    root.append(ui.page({ title: 'Supplier not found' }, ui.empty({ icon: 'users', title: 'This supplier no longer exists', action: ui.button('Suppliers', { href: '#/purchasing/vendors' }) })));
    return;
  }
  const money = moneyFormatter(store.settings());
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); saveIt(); } }, ui.formGrid(vendorFields(v)), h('button', { type: 'submit', hidden: true }));
  const saveIt = () => {
    if (!form.reportValidity()) return;
    const rec = cleanVendor({ ...store.get('vendors', id), ...ui.readForm(form) });
    const problems = vendorProblems(rec, store.list('vendors'));
    if (problems.length) { ui.toast(problems[0], 'error', 4000); return; }
    store.update('vendors', id, strip(rec), { summary: rec.name });
    ui.toast('Supplier saved', 'success');
  };
  const bills = store.list('bills', (b) => b.vendorId === id, { omit: ['receipt'] }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const orders = store.list('purchaseOrders', (p) => p.vendorId === id);
  const owed = bills.filter(billOutstanding).reduce((s, b) => s + billTotals(b).totalCents, 0);
  const remove = async () => {
    if (bills.length || orders.length) {
      ui.toast(`${vendorName(v)} has ${bills.length} bill${bills.length === 1 ? '' : 's'} and ${orders.length} order${orders.length === 1 ? '' : 's'}. Untick Active instead; everything stays on record.`, 'error', 5000);
      return;
    }
    if (!(await ui.confirmDialog(`Delete ${vendorName(v)}?`, { okLabel: 'Delete' }))) return;
    store.remove('vendors', id);
    nav('#/purchasing/vendors');
  };
  const today = ui.today();
  root.append(ui.page({
    title: vendorName(v), subtitle: h('span', { class: 'row-inline' }, h('a', { href: '#/purchasing/vendors' }, 'Suppliers'), owed ? ` · ${money(owed)} to pay` : '', qboBadge(ctx, 'vendors', id, { record: v })),
    actions: [
      ui.button('New bill', { icon: 'plus', href: `#/purchasing/bills/new?vendorId=${encodeURIComponent(id)}` }),
      ui.button('New order', { icon: 'file-text', href: `#/purchasing/orders/new?vendorId=${encodeURIComponent(id)}` }),
      ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete supplier', onClick: remove }),
    ],
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, form, h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save', { variant: 'primary', icon: 'save', onClick: saveIt })))),
    h('aside', { class: 'doc-side stack' },
      h('div', { class: 'card' }, h('h3', null, 'Bills and receipts'), bills.length
        ? h('div', { class: 'list' }, bills.slice(0, 30).map((b) => h('a', { class: 'list-row click', href: '#/purchasing/bills/' + b.id },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `${kindLabel(b)} ${b.number || ''}`.trim()), h('div', { class: 'meta' }, ui.fmtDate(b.date))),
          h('span', { class: 'num' }, money(billTotals(b).totalCents)), statusBadge(ui, billStatusOf(b, today), BILL_STATUS_LABEL))))
        : h('p', { class: 'muted pu-note' }, 'None yet.')),
      h('div', { class: 'card' }, h('h3', null, 'Purchase orders'), orders.length
        ? h('div', { class: 'list' }, orders.slice(0, 30).map((p) => h('a', { class: 'list-row click', href: '#/purchasing/orders/' + p.id },
          h('div', { class: 'grow' }, h('div', { class: 'title mono' }, p.number), h('div', { class: 'meta' }, ui.fmtDate(p.date))),
          h('span', { class: 'num' }, money(poTotalCents(p))), statusBadge(ui, p.status || 'draft', PO_STATUS_LABEL))))
        : h('p', { class: 'muted pu-note' }, 'None yet.'))))));
}

// ---------- purchase orders: list ----------

const PO_TABS = [{ id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'draft', label: 'Drafts' }, { id: 'closed', label: 'Closed' }, { id: 'cancelled', label: 'Cancelled' }];
const inPoTab = (tab, p) => (tab === 'all' ? true : tab === 'open' ? poOpen(p) : (p.status || 'draft') === tab);

function renderOrders(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let tab = 'open', q = '';
  const host = h('div', { class: 'stack' });
  const tableHost = h('div');
  const money = moneyFormatter(store.settings());
  const draw = () => {
    ui.clear(host);
    const all = store.list('purchaseOrders');
    if (!all.some((p) => inPoTab(tab, p)) && tab === 'open' && all.length) tab = 'all';
    host.append(
      h('div', { class: 'row' },
        ui.tabs(PO_TABS.map((t) => ({ id: t.id, label: `${t.label} ${all.filter((p) => inPoTab(t.id, p)).length || ''}`.trim() })), tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }),
        ui.searchBox('Search orders', (v) => { q = v; drawTable(); }, q)),
      tableHost);
    drawTable();
  };
  const drawTable = () => {
    const vendors = vendorMap(store), jobs = jobMap(store);
    const bills = store.list('bills', null, { omit: ['receipt'] });
    const all = store.list('purchaseOrders');
    const n = q.trim().toLowerCase();
    const rows = all.filter((p) => inPoTab(tab, p) && (!n || [p.number, vendorName(vendors.get(p.vendorId)), jobs.get(p.jobId)?.number, ...(p.lines || []).map((l) => l.description)].some((s) => String(s || '').toLowerCase().includes(n))))
      .sort((a, b) => String(b.number || '').localeCompare(String(a.number || ''), undefined, { numeric: true }));
    ui.clear(tableHost).append(
      ui.table({
        columns: [
          { key: 'number', label: 'Number', render: (p) => h('span', { class: 'mono' }, p.number || '—'), sort: (p) => p.number || '' },
          { key: 'date', label: 'Date', render: (p) => ui.fmtDate(p.date), sort: (p) => p.date || '' },
          { key: 'vendor', label: 'Supplier', render: (p) => vendorName(vendors.get(p.vendorId)), sort: (p) => vendorName(vendors.get(p.vendorId)) },
          { key: 'job', label: 'Job', render: (p) => (p.jobId ? jobs.get(p.jobId)?.number || '—' : '—') },
          { key: 'expected', label: 'Needed by', render: (p) => ui.fmtDate(p.expectedDate), sort: (p) => p.expectedDate || '' },
          { key: 'total', label: 'Total', align: 'right', render: (p) => money(poTotalCents(p)), sort: (p) => poTotalCents(p) },
          { key: 'billed', label: 'Billed', align: 'right', render: (p) => { const c = poBilled(p, bills).billedCents; return c ? money(c) : '—'; } },
          { key: 'status', label: 'Status', render: (p) => h('span', { class: 'row-inline' }, statusBadge(ui, p.status || 'draft', PO_STATUS_LABEL), qboBadge(ctx, 'purchaseOrders', p.id, { record: p })), sort: (p) => p.status || '' },
        ],
        rows,
        onRowClick: (p) => nav('#/purchasing/orders/' + p.id),
        empty: ui.empty({ icon: 'file-text', title: all.length ? 'Nothing here' : 'No purchase orders yet',
          text: all.length ? 'Try another tab or search.' : 'Make one here, or from the crew’s material requests (Material requests → select → Create purchase order).',
          action: all.length ? null : ui.button('New purchase order', { variant: 'primary', icon: 'plus', href: '#/purchasing/orders/new' }) }),
      }));
  };
  root.append(ui.page({ title: 'Purchasing', subtitle: 'Purchase orders to your suppliers',
    actions: [ui.button('New purchase order', { variant: 'primary', icon: 'plus', href: '#/purchasing/orders/new' })] },
  subnav(ctx, 'orders'), host));
  draw();
  const offs = ['purchaseOrders', 'bills', 'vendors'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

/**
 * Reserve the next PO number: the settings counter, but past any number a PO on this device
 * already has (lib nextPoNumber), with one settings write.
 */
export function takePoNumber(store) {
  const s = store.settings();
  const { number, next } = nextPoNumber(s, store.list('purchaseOrders'));
  store.update('settings', 'settings', { nextNumbers: { ...s.nextNumbers, po: next } }, { silent: true });
  return number;
}

/** Give back the number of a PO that was deleted unused, when it was the last one handed out. */
function returnPoNumber(store, number) {
  const n = parsePoNumber(number);
  const s = store.settings();
  if (n == null || s.nextNumbers?.po !== n + 1 || store.list('purchaseOrders').some((p) => parsePoNumber(p.number) >= n)) return;
  store.update('settings', 'settings', { nextNumbers: { ...s.nextNumbers, po: n } }, { silent: true });
}

function createOrder(ctx) {
  const { store, ui, query } = ctx;
  const vendor = query.vendorId ? store.get('vendors', query.vendorId) : null;
  const rec = newPurchaseOrder({ number: takePoNumber(store), vendorId: vendor?.id || null, jobId: query.jobId || null, today: ui.today() });
  const job = rec.jobId ? store.get('jobs', rec.jobId) : null;
  if (job?.address) rec.shipTo = job.address;
  const created = store.add('purchaseOrders', rec);
  // fresh: backing out before filling anything in deletes it again (renderOrder).
  location.replace('#/purchasing/orders/' + created.id + '?fresh=1');
}

// ---------- purchase orders: one ----------

function renderOrder(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const found = store.get('purchaseOrders', id);
  if (!found) {
    root.append(ui.page({ title: 'Order not found' }, ui.empty({ icon: 'file-text', title: 'This purchase order no longer exists', action: ui.button('Purchase orders', { href: '#/purchasing/orders' }) })));
    return;
  }
  const doc = found;
  doc.lines = Array.isArray(doc.lines) ? doc.lines : [];
  const money = moneyFormatter(store.settings());
  const readOnly = () => ['closed', 'cancelled'].includes(doc.status);
  // Saves only the fields typed into; status goes through setStatus, and QuickBooks closing the
  // order (or another office user) is taken in here rather than written back over: POs only push,
  // so writing 'open' back would reopen the order in QuickBooks.
  let wasReadOnly = readOnly();
  const ed = recordEditor(store, 'purchaseOrders', id, doc, {
    summary: () => doc.number,
    onTooBig: tooBigToast(ui, 'purchaseOrders'),
    onPulled: () => { if (readOnly() !== wasReadOnly) drawAll(); else { drawLines(); drawSide(); } },
    onRemoved: () => { ui.toast(`${doc.number || 'This order'} was deleted on another device`, 'info', 4000); nav('#/purchasing/orders'); },
  });
  const changed = (...fields) => { ed.touch(...fields); drawSide(); };

  const headerHost = h('div');
  const drawHeader = () => {
    const jobs = sortedJobs(store);
    const field = (label, control, span) => h('label', { class: ['field', span ? 'span-2' : null] }, h('span', null, label), control);
    const input = (name, type, value, onVal, extra = {}) => {
      const el = h(type === 'textarea' ? 'textarea' : 'input', { name, ...(type === 'textarea' ? { rows: 2 } : { type, value: value ?? '' }), readonly: readOnly(), ...extra }, type === 'textarea' ? value || '' : null);
      el.addEventListener(type === 'date' ? 'change' : 'input', () => { onVal(el.value); changed(name); });
      return el;
    };
    const job = h('select', { name: 'jobId', disabled: readOnly() }, h('option', { value: '' }, '— no job (shop stock) —'), jobs.map((j) => h('option', { value: j.id, selected: doc.jobId === j.id }, jobLabel(j))));
    job.addEventListener('change', () => {
      doc.jobId = job.value || null;
      const j = doc.jobId ? store.get('jobs', doc.jobId) : null;
      if (j?.address && !doc.shipTo) { doc.shipTo = j.address; drawHeader(); }
      changed('jobId', 'shipTo');
    });
    ui.clear(headerHost).append(h('div', { class: 'form-grid' },
      field('Number', input('number', 'text', doc.number, (v) => { doc.number = v.slice(0, 40); }, { maxlength: '40' })),
      field('Supplier', vendorSelect(ctx, { value: doc.vendorId, disabled: readOnly(), onPick: (v) => { doc.vendorId = v; changed('vendorId'); } })),
      field('Date', input('date', 'date', doc.date, (v) => { doc.date = v || null; })),
      field('Needed by', input('expectedDate', 'date', doc.expectedDate, (v) => { doc.expectedDate = v || null; })),
      field('Job', job),
      field('Ship to', input('shipTo', 'textarea', doc.shipTo, (v) => { doc.shipTo = v.slice(0, 500); }, { maxlength: '500' })),
      field('Notes for the supplier', input('notes', 'textarea', doc.notes, (v) => { doc.notes = v.slice(0, 2000); }, { maxlength: '2000' }), true)));
  };

  const linesHost = h('div', { class: 'lines pu-lines' });
  const drawLines = () => {
    ui.clear(linesHost);
    const jobs = sortedJobs(store);
    const items = new Map(store.list('items').map((i) => [i.id, i]));
    const requests = new Map(store.list('materialRequests').map((r) => [r.id, r]));
    const bills = store.list('bills', null, { omit: ['receipt'] });
    if (!doc.lines.length) linesHost.append(h('div', { class: 'lines-empty muted' }, 'No lines yet. Add what you are ordering, or make the order from the crew’s material requests.'));
    doc.lines.forEach((l, i) => {
      const amount = h('div', { class: 'line-amount num' }, money(poLineCents(l)));
      const set = (patch) => { doc.lines[i] = { ...doc.lines[i], ...patch }; amount.textContent = money(poLineCents(doc.lines[i])); changed('lines'); };
      const desc = h('input', { class: 'input', name: 'description', value: l.description || '', placeholder: 'What to order', maxlength: '4000', readonly: readOnly(), 'aria-label': `Line ${i + 1} description` });
      desc.addEventListener('input', () => set({ description: desc.value }));
      const qty = h('input', { class: 'input num', name: 'qty', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.qty ?? 1, readonly: readOnly(), 'aria-label': `Line ${i + 1} quantity` });
      qty.addEventListener('input', () => set({ qty: Number(qty.value) || 0 }));
      const unit = h('input', { class: 'input pu-unit', name: 'unit', value: l.unit || '', placeholder: 'ea', maxlength: '30', readonly: readOnly(), 'aria-label': `Line ${i + 1} unit` });
      unit.addEventListener('input', () => set({ unit: unit.value }));
      const cost = moneyInput(ui, { name: 'unitCents', label: `Line ${i + 1} unit cost`, value: l.unitCents ?? null, placeholder: '0.00', readonly: readOnly(), onValue: (c) => set({ unitCents: c == null ? 0 : Math.abs(c) }) });
      const job = h('select', { name: 'lineJobId', class: 'line-kind', disabled: readOnly(), 'aria-label': `Line ${i + 1} job` },
        h('option', { value: '' }, doc.jobId ? 'Order’s job' : 'No job'), jobs.map((j) => h('option', { value: j.id, selected: l.jobId === j.id }, j.number || j.title)));
      job.addEventListener('change', () => set({ jobId: job.value || null }));
      const reqs = (l.materialRequestIds || []).map((rid) => requests.get(rid)).filter(Boolean);
      linesHost.append(h('div', { class: 'line-row pu-line pu-po-line', dataset: { line: String(i) } },
        h('div', { class: 'line-desc' }, desc, h('div', { class: 'line-meta' }, job, unit,
          l.itemId && items.get(l.itemId) ? h('span', { class: 'muted' }, 'price book') : null,
          reqs.length ? h('span', { class: 'muted', title: reqs.map((r) => `${qtyText(r)} ${requestName(r, items)}`).join('\n') }, `${reqs.length} material request${reqs.length === 1 ? '' : 's'}`) : null)),
        h('label', { class: 'line-qty' }, h('span', { class: 'line-label' }, 'Qty'), qty),
        h('label', { class: 'line-unit' }, h('span', { class: 'line-label' }, 'Unit cost'), cost),
        h('div', { class: 'line-amt' }, h('span', { class: 'line-label' }, 'Amount'), amount),
        // Bills point at PO lines by position: once placed, an order's lines are only added to.
        readOnly() || poLineLocked(doc, bills, i) ? h('div') : h('div', { class: 'line-actions' }, ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: `Remove line ${i + 1}`, onClick: () => {
          const out = removePoLine(doc, i, store.list('bills', null, { omit: ['receipt'] }));
          if (out.error) { ui.toast(out.error, 'error', 4500); drawLines(); return; }
          doc.lines = out.lines; drawLines(); changed('lines');
        } }))));
    });
    if (readOnly()) return;
    const full = doc.lines.length >= MAX_LINES;
    linesHost.append(h('div', { class: 'row lines-add' },
      ui.button('Add line', { size: 'sm', icon: 'plus', disabled: full, onClick: () => { doc.lines.push({ itemId: null, description: '', qty: 1, unit: 'ea', unitCents: 0, jobId: null, materialRequestIds: [] }); drawLines(); changed('lines'); } }),
      ui.button('From the price book', { size: 'sm', icon: 'box', disabled: full, onClick: () => pickItems(store, (it) => {
        if (doc.lines.length >= MAX_LINES) return;
        doc.lines.push({ itemId: it.id, description: it.name, qty: 1, unit: it.unit || 'ea', unitCents: Math.abs(Number(it.costCents) || 0), jobId: null, materialRequestIds: [] });
        drawLines(); changed('lines');
      }) })));
  };

  const sideHost = h('div', { class: 'stack' });
  const setStatus = (status, extra = {}) => {
    ed.write({ status, ...extra }, { summary: `${doc.number} → ${status}` });
    drawAll();
  };
  const reqIds = () => [...new Set(doc.lines.flatMap((l) => l.materialRequestIds || []))];
  const cancel = async () => {
    const ids = reqIds();
    const back = store.list('materialRequests', (r) => ids.includes(r.id) && r.status === 'ordered');
    if (!(await ui.confirmDialog(`Cancel ${doc.number}?${back.length ? ` Its ${back.length} material request${back.length === 1 ? ' goes' : 's go'} back on the To order list.` : ''}`, { okLabel: 'Cancel order', title: 'Cancel the order?' }))) return;
    for (const r of back) store.update('materialRequests', r.id, requestAfterPoCancel(r), { summary: `back to order: ${doc.number} cancelled` });
    setStatus('cancelled');
  };
  // Restoring a cancelled order puts its requests back on it, unless one has been ordered since.
  const restore = () => {
    const ids = reqIds();
    const elsewhere = requestOrders(store);
    const again = store.list('materialRequests', (r) => ids.includes(r.id) && orderableRequest(r) && !elsewhere.has(r.id));
    const at = new Date().toISOString();
    for (const r of again) store.update('materialRequests', r.id, { status: 'ordered', orderedAt: at }, { summary: `ordered on ${doc.number}` });
    setStatus('draft');
    const gone = ids.length - again.length;
    if (gone) ui.toast(`${gone} of its material request${gone === 1 ? ' is' : 's are'} no longer waiting to be ordered: check the lines before placing it.`, 'info', 5000);
  };
  const enterBill = () => {
    ed.flush();
    const bills = store.list('bills', null, { omit: ['receipt'] });
    const draft = billFromPo(doc, { bills, settings: store.settings(), today: ui.today() });
    if (!draft.lines.length) { ui.toast('Everything on this order has been billed', 'info', 3500); return; }
    draft.dueDate = dueFromTerms(store.get('vendors', doc.vendorId)?.terms, draft.date) || draft.dueDate;
    const b = store.add('bills', draft);
    nav('#/purchasing/bills/' + b.id);
  };
  const copyText = async () => {
    ed.flush();
    const text = poText(doc, { vendor: store.get('vendors', doc.vendorId), company: store.settings().company?.name || '', jobs: jobMap(store), money });
    try { await navigator.clipboard.writeText(text); ui.toast('Copied: paste it into an email or the supplier’s order form', 'success', 3500); } catch { ui.download(`${doc.number || 'purchase-order'}.txt`, text, 'text/plain'); }
  };
  const drawSide = () => {
    const st = doc.status || 'draft';
    const problems = poProblems(doc);
    const billed = poBilled(doc, store.list('bills', null, { omit: ['receipt'] }));
    const total = poTotalCents(doc);
    const row = (label, v, cls) => h('div', { class: ['totals-row', cls] }, h('span', null, label), h('span', { class: 'num' }, v));
    const place = () => { if (problems.length) { ui.toast(problems[0], 'error', 4000); return; } setStatus('open'); ui.toast(`${doc.number} placed`, 'success'); };
    h(ui.clear(sideHost), null,
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('strong', null, 'Status'), h('span', { class: 'grow' }), qboBadge(ctx, 'purchaseOrders', doc.id, { record: doc }), statusBadge(ui, st, PO_STATUS_LABEL)),
        st === 'draft' && problems.length ? h('ul', { class: 'pu-problems' }, problems.map((p) => h('li', { class: 'block' }, p))) : null,
        h('div', { class: 'row pu-actions' },
          st === 'draft' ? ui.button('Place order', { size: 'sm', variant: 'primary', icon: 'check', onClick: place }) : null,
          st === 'open' ? ui.button('Mark sent', { size: 'sm', icon: 'send', onClick: () => setStatus('sent', { sentAt: new Date().toISOString() }) }) : null,
          poOpen(doc) ? ui.button('Enter bill', { size: 'sm', variant: 'primary', icon: 'receipt', onClick: enterBill }) : null,
          poOpen(doc) ? ui.button('Close', { size: 'sm', onClick: () => setStatus('closed', { closedAt: new Date().toISOString() }) }) : null,
          st === 'closed' ? ui.button('Reopen', { size: 'sm', onClick: () => setStatus('open', { closedAt: null }) }) : null,
          ['draft', 'open', 'sent'].includes(st) ? ui.button('Cancel order', { size: 'sm', variant: 'ghost danger', onClick: cancel }) : null,
          st === 'cancelled' ? ui.button('Restore', { size: 'sm', onClick: restore }) : null),
        ui.button('Copy for the supplier', { size: 'sm', variant: 'ghost', icon: 'copy', onClick: copyText }),
        doc.jobId ? ui.button('Open job', { size: 'sm', variant: 'ghost', icon: 'briefcase', href: '#/jobs/' + doc.jobId }) : null),
      h('div', { class: 'card' }, h('h3', null, 'Totals'), h('div', { class: 'totals' },
        row('Order (before tax)', money(total), 'grand'),
        row('Billed so far', money(billed.billedCents)),
        billed.billIds.length ? h('div', { class: 'stack pu-billed' }, billed.billIds.map((bid) => {
          const b = store.get('bills', bid);
          return b ? h('a', { href: '#/purchasing/bills/' + bid }, `${kindLabel(b)} ${b.number || ui.fmtDate(b.date)} · ${money(billTotals(b).totalCents)}`) : null;
        })) : null)));
  };

  const remove = async () => {
    if (doc.status !== 'draft') { ui.toast('Only a draft can be deleted. Cancel the order instead; it stays on record.', 'error', 4000); return; }
    if (!(await ui.confirmDialog(`Delete ${doc.number}?`, { okLabel: 'Delete' }))) return;
    ed.stop();
    store.remove('purchaseOrders', id);
    nav('#/purchasing/orders');
  };

  const bannerHost = h('div');
  const drawBanner = () => {
    ui.clear(bannerHost);
    if (readOnly()) bannerHost.append(h('div', { class: 'card money-void' }, statusBadge(ui, doc.status, PO_STATUS_LABEL), ' This order is read-only.'));
  };
  const drawAll = () => { wasReadOnly = readOnly(); drawBanner(); drawHeader(); drawLines(); drawSide(); };

  drawAll();
  root.append(ui.page({
    title: doc.number || 'Purchase order',
    subtitle: h('span', null, h('a', { href: '#/purchasing/orders' }, 'Purchase orders'), ' / ', vendorName(store.get('vendors', doc.vendorId))),
    actions: [ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete order', onClick: remove })],
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      bannerHost,
      h('div', { class: 'card' }, headerHost),
      h('div', { class: 'card' }, h('h3', null, 'Lines'), linesHost)),
    h('aside', { class: 'doc-side' }, sideHost))));
  return () => {
    ed.stop();
    // "New purchase order" and straight back out: nothing was filled in, so nothing is kept.
    const cur = store.get('purchaseOrders', id);
    if (ctx.query.fresh && blankPurchaseOrder(cur)) { store.remove('purchaseOrders', id); returnPoNumber(store, cur.number); }
  };
}

// ---------- purchase orders from material requests (modules/materials.js) ----------

/**
 * The "Create purchase order" sheet for selected material requests: pick the supplier for all of
 * them, or one per request; one PO is made per supplier, numbered PO-, and the requests are marked
 * ordered. Calls onDone(orders) after creating them.
 */
export function purchaseOrderSheet(ctx, requests, { onDone } = {}) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  ensureStyles();
  const list = requests.filter(orderableRequest);
  if (!list.length) { ui.toast('Pick requests that are waiting or to order', 'error'); return; }
  const items = new Map(store.list('items').map((i) => [i.id, i]));
  const jobs = jobMap(store);
  const chosen = new Map(list.map((r) => [r.id, '']));
  const rowsHost = h('div', { class: 'list pu-po-requests' });
  const drawRows = () => {
    ui.clear(rowsHost);
    for (const r of list) {
      const sel = vendorSelect(ctx, { value: chosen.get(r.id) || null, name: `vendor-${r.id}`, onPick: (v) => { chosen.set(r.id, v || ''); } });
      rowsHost.append(h('div', { class: 'list-row', dataset: { request: r.id } },
        h('span', { class: 'qty num' }, qtyText(r)),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, requestName(r, items)), h('div', { class: 'meta' }, jobLabel(jobs.get(r.jobId)))),
        h('label', { class: 'field pu-vendor-pick' }, h('span', { class: 'sr-only' }, 'Supplier'), sel)));
    }
  };
  const all = vendorSelect(ctx, { value: null, name: 'vendorAll', onPick: (v) => { for (const r of list) chosen.set(r.id, v || ''); drawRows(); } });
  drawRows();
  const sheet = ui.openSheet({
    title: `Purchase order · ${list.length} request${list.length === 1 ? '' : 's'}`, wide: true,
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Supplier for all'), all),
      h('p', { class: 'muted pu-note' }, 'Or pick a supplier per line: one purchase order is made for each supplier. Same items for the same job are added up. The requests are marked ordered.'),
      rowsHost),
    actions: [
      h('span', { class: 'grow' }),
      ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }),
      ui.button('Create purchase order', { variant: 'primary', icon: 'check', onClick: () => {
        if ([...chosen.values()].some((v) => !v)) { ui.toast('Pick a supplier for every request', 'error'); return; }
        const groups = ordersFromRequests(list, (r) => chosen.get(r.id), { items, today: ui.today() });
        // They are placed (open) at once, so they must be complete: a request with no quantity stops it.
        const vendorsNow = vendorMap(store);
        for (const g of groups) {
          const problems = poProblems(g.order);
          if (problems.length) { ui.toast(`${vendorName(vendorsNow.get(g.vendorId))}: ${problems[0]}`, 'error', 4500); return; }
        }
        const at = new Date().toISOString();
        const me = auth.current?.()?.id || null;
        const made = [];
        for (const g of groups) {
          const job = g.order.jobId ? jobs.get(g.order.jobId) : null;
          const po = store.add('purchaseOrders', { ...g.order, number: takePoNumber(store), shipTo: job?.address || '' });
          for (const rid of g.requestIds) store.update('materialRequests', rid, { status: 'ordered', orderedAt: at, handledBy: me }, { summary: `ordered on ${po.number}` });
          made.push(po);
        }
        sheet.close();
        const vendors = vendorMap(store);
        ui.toast(made.map((p) => `${p.number} for ${vendorName(vendors.get(p.vendorId))}`).join(', '), 'success', 4000);
        onDone?.(made);
        if (made.length === 1) nav('#/purchasing/orders/' + made[0].id);
      } }),
    ],
  });
  return sheet;
}

/** The PO numbers that cover each material request: Map requestId -> 'PO-5001'. */
export function requestOrders(store) {
  const out = new Map();
  for (const p of store.list('purchaseOrders')) {
    if (p.status === 'cancelled') continue;
    for (const l of p.lines || []) for (const rid of l.materialRequestIds || []) out.set(rid, p.number);
  }
  return out;
}
