// Invoices & payments (S18): list with ageing, builder, payments, print.
import { docTotals, invoicePaidCents, invoiceBalanceCents, invoiceStatus, moneyFormatter, combinedPct } from '../lib/money.js';
import { newDocTax, taxComponents, TREATMENTS } from '../lib/tax.js';
import { lineEditor, taxEditor, totalsPanel, previewDocument, clientName } from '../lib/doc-view.js';
import { invoiceOnlineTools, payLinkBlock } from './integrations.js';
import { moduleOn } from '../lib/modules.js';
import { billingLabel, restoreConflicts } from '../lib/tm.js';
import { qboBadge, noTaxReasonPicker, isSettlementPayment, SETTLEMENT_LABEL, settlementNote, lookupAction, needsNoTaxReason, keepsServerPaid, nextInvoiceStatus, docEditor } from '../lib/qbo-ui.js';

const METHODS = ['e-transfer', 'cheque', 'card', 'cash', 'transfer'];

export default {
  id: 'invoices',
  title: 'Invoices',
  icon: 'receipt',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (sub === 'new') { createNew(ctx); return; }
    if (sub) return renderDetail(root, ctx, sub);
    return renderList(root, ctx);
  },
};

/**
 * Status and balance as the invoice screens show them. A 'paid' the server set at the QuickBooks
 * total (its own tax rounding, docs/integrations/quickbooks.md 4.8) stays paid with a balance of 0,
 * although a cent or two is left by Fishtape's arithmetic (lib/qbo-ui.js keepsServerPaid).
 */
export function invoiceShown(store, inv) {
  if (inv.status === 'void') return { status: 'void', balanceCents: 0 };
  const paid = invoicePaidCents(store, inv.id);
  if (keepsServerPaid(inv, paid, docTotals(inv).totalCents)) return { status: 'paid', balanceCents: 0 };
  return { status: invoiceStatus(store, inv), balanceCents: invoiceBalanceCents(store, inv) };
}

/**
 * Recompute the stored status from payments (never touches void). `moneyChanged` false (an edit
 * that left the total as it was) keeps a 'paid' the server set within the tax rounding.
 */
export function syncInvoiceStatus(store, invId, { moneyChanged = true } = {}) {
  const inv = store.get('invoices', invId);
  if (!inv || inv.status === 'void') return inv;
  const next = nextInvoiceStatus(inv, invoicePaidCents(store, invId), docTotals(inv).totalCents, { moneyChanged });
  if (next !== inv.status) return store.update('invoices', invId, { status: next }, { summary: `${inv.number} → ${next}` });
  return inv;
}

// ---------- list ----------
function renderList(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let tab = 'all', q = '';
  const host = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(host);
    const all = store.list('invoices').map((inv) => {
      const { status, balanceCents: balance } = invoiceShown(store, inv);
      return { inv, status, total: docTotals(inv).totalCents, balance };
    });
    const open = all.filter((r) => !['void', 'draft', 'paid'].includes(r.status) && r.balance > 0);
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
    for (const r of open) {
      const past = r.inv.dueDate ? -ui.daysUntil(r.inv.dueDate) : 0;
      if (past <= 0) buckets.current += r.balance;
      else if (past <= 30) buckets.d30 += r.balance;
      else if (past <= 60) buckets.d60 += r.balance;
      else if (past <= 90) buckets.d90 += r.balance;
      else buckets.d90p += r.balance;
    }
    const outstanding = open.reduce((s, r) => s + r.balance, 0);
    const overdue = outstanding - buckets.current;
    const money = moneyFormatter(store.settings());
    const m = (c) => money(c, { whole: true });
    h(host, null,
      h('div', { class: 'grid money-stats' },
        ui.stat({ label: 'Outstanding', value: m(outstanding), hint: `${open.length} open invoices`, tone: 'accent' }),
        ui.stat({ label: 'Overdue', value: m(overdue), hint: `${open.filter((r) => r.status === 'overdue').length} past due`, tone: overdue ? 'danger' : null }),
        ui.stat({ label: 'Collected (30 days)', value: m(store.list('payments', (p) => ui.daysUntil(p.date) >= -30).reduce((s, p) => s + p.amountCents, 0)), tone: 'success' })),
      h('div', { class: 'card ageing' },
        h('h3', null, 'Ageing'),
        h('div', { class: 'ageing-row' }, [
          ['Current', buckets.current], ['1–30 days', buckets.d30], ['31–60', buckets.d60], ['61–90', buckets.d90], ['90+', buckets.d90p],
        ].map(([label, v], i) => h('div', { class: ['ageing-cell', i && v ? 'late' : null] },
          h('span', { class: 'label' }, label), h('span', { class: 'value num' }, m(v)),
          h('div', { class: 'progress' }, h('i', { style: { width: outstanding ? `${Math.round((v / outstanding) * 100)}%` : '0%' } })))))),
      h('div', { class: 'row' },
        ui.tabs([
          { id: 'all', label: `All ${all.length}` }, { id: 'open', label: `Open ${open.length}` },
          { id: 'overdue', label: `Overdue ${all.filter((r) => r.status === 'overdue').length}` },
          { id: 'paid', label: 'Paid' }, { id: 'draft', label: 'Draft' }, { id: 'void', label: 'Void' },
        ], tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }),
        ui.searchBox('Search invoices', (v) => { q = v; drawTable(); }, q)),
      tableHost);
    drawTable();

    function drawTable() {
      const n = q.trim().toLowerCase();
      const rows = all.filter((r) => {
        if (tab === 'open' && !open.includes(r)) return false;
        if (!['all', 'open'].includes(tab) && r.status !== tab) return false;
        const job = r.inv.jobId ? store.get('jobs', r.inv.jobId) : null;
        return !n || [r.inv.number, clientName(store, r.inv.clientId), job?.title].some((s) => (s || '').toLowerCase().includes(n));
      });
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.inv.number), sort: (r) => r.inv.number },
          { key: 'client', label: 'Client / job', render: (r) => clientOrJob(store, r.inv), sort: (r) => clientOrJob(store, r.inv) },
          { key: 'issue', label: 'Issued', render: (r) => ui.fmtDate(r.inv.issueDate), sort: (r) => r.inv.issueDate || '' },
          { key: 'due', label: 'Due', render: (r) => ui.fmtDate(r.inv.dueDate), sort: (r) => r.inv.dueDate || '' },
          { key: 'total', label: 'Total', align: 'right', render: (r) => money(r.total), sort: (r) => r.total },
          { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance), sort: (r) => r.balance },
          { key: 'status', label: 'Status', render: (r) => h('span', { class: 'row-inline' }, ui.statusBadge(r.status), qboBadge(ctx, 'invoices', r.inv.id, { record: r.inv })), sort: (r) => r.status },
        ],
        rows,
        onRowClick: (r) => nav('#/invoices/' + r.inv.id),
        empty: ui.empty({ icon: 'receipt', title: all.length ? 'Nothing here' : 'No invoices yet',
          text: all.length ? 'Try another tab or search.' : 'Create one from an accepted estimate or a job.',
          action: all.length ? null : ui.button('New invoice', { variant: 'primary', icon: 'plus', href: '#/invoices/new' }) }),
      }));
    }
  };
  const tableHost = h('div');
  root.append(ui.page({
    title: 'Invoices', subtitle: 'Billing, payments and what is owed',
    actions: [ui.button('New invoice', { variant: 'primary', icon: 'plus', href: '#/invoices/new' })],
  }, host));
  draw();
  const u1 = store.on('invoices', draw), u2 = store.on('payments', draw);
  return () => { u1(); u2(); };
}

function clientOrJob(store, inv) {
  const c = inv.clientId ? store.get('clients', inv.clientId)?.name : null;
  const j = inv.jobId ? store.get('jobs', inv.jobId) : null;
  return [c, j ? `${j.number} ${j.title}` : null].filter(Boolean).join(' · ') || '—';
}

// ---------- new ----------
async function createNew(ctx) {
  const { store, ui, query } = ctx;
  const s = store.settings();
  const rec = {
    number: null, clientId: null, jobId: null, estimateId: null, status: 'draft', lines: [],
    ...newDocTax(s, ui.today()), issueDate: ui.today(), dueDate: ui.today(14), notes: '',
  };
  if (query.estimateId) {
    const e = store.get('estimates', query.estimateId);
    if (e) {
      const t = docTotals(e);
      Object.assign(rec, { clientId: e.clientId || null, jobId: e.jobId || null, estimateId: e.id, notes: e.notes || '', title: e.title || '' });
      Object.assign(rec, invoiceTaxFromEstimate(e, rec));
      rec.lines = (e.lines || []).map((l) => ({ ...l }));
      if (t.markupCents) rec.lines.push({ itemId: null, description: `Materials markup (${e.markupPct}%)`, qty: 1, unitCents: t.markupCents, labourHours: 0, kind: 'other' });
      // The estimate's "Why no tax?" reason comes along while the invoice is still untaxed.
      if (e.taxNoneReason && needsNoTaxReason(rec)) rec.taxNoneReason = e.taxNoneReason;
    }
  } else if (query.jobId) {
    const job = store.get('jobs', query.jobId);
    if (job) {
      rec.jobId = job.id;
      rec.clientId = job.clientId || null;
      rec.title = job.title || '';
      const billed = new Set(store.list('invoices', (i) => i.jobId === job.id).flatMap((i) => (i.lines || []).map((l) => l.changeOrderId).filter(Boolean)));
      const cos = (job.changeOrders || []).filter((c) => c.status === 'approved' && !billed.has(c.id));
      if (cos.length && await ui.confirmDialog(`${job.number} has ${cos.length} approved change order${cos.length > 1 ? 's' : ''} not yet billed. Add ${cos.length > 1 ? 'them' : 'it'} to this invoice?`, { title: 'Bill change orders?', okLabel: 'Add', danger: false })) {
        rec.lines.push(...cos.map((c) => ({ itemId: null, changeOrderId: c.id, description: `Change order: ${c.title}`, qty: 1, unitCents: c.amountCents || 0, labourHours: 0, kind: 'other' })));
      }
    }
  } else if (query.clientId) rec.clientId = query.clientId;
  rec.number = store.nextNumber('invoice');
  const created = store.add('invoices', rec);
  location.replace('#/invoices/' + created.id);
}

/** Keep the estimate's tax choice, re-rated for the invoice date (rates change, e.g. NS HST in 2025). */
function invoiceTaxFromEstimate(e, rec) {
  if (!Array.isArray(e.taxes)) {
    // An estimate from before tax.js: keep its single rate.
    delete rec.taxes; delete rec.taxProvince; delete rec.taxTreatment;
    return { taxPct: e.taxPct ?? rec.taxPct };
  }
  if (e.taxProvince && TREATMENTS[e.taxTreatment]) {
    const taxes = taxComponents({ province: e.taxProvince, treatment: e.taxTreatment, date: rec.issueDate });
    return { taxes, taxProvince: e.taxProvince, taxTreatment: e.taxTreatment, taxPct: combinedPct(taxes.filter((t) => t.applies.material || t.applies.labour || t.applies.other)) };
  }
  return { taxes: e.taxes.map((t) => ({ ...t })), taxProvince: e.taxProvince ?? null, taxTreatment: e.taxTreatment, taxPct: e.taxPct };
}

// ---------- detail ----------
function renderDetail(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const inv = store.get('invoices', id);
  if (!inv) {
    root.append(ui.page({ title: 'Invoice not found' }, ui.empty({ icon: 'receipt', title: 'This invoice no longer exists', action: ui.button('All invoices', { href: '#/invoices' }) })));
    return;
  }
  const doc = inv;
  // Saves only the fields changed here (never status, which its buttons write), and takes in what
  // QuickBooks or another device changed while the invoice is open (contract 5.10): the whole
  // record saved on every keystroke would write a pulled change back over the books.
  const save = docEditor(store, 'invoices', id, doc, {
    write: (patch, opts) => store.update('invoices', id, patch, opts),
    onSaved: (patch, before, after) => {
      // A notes edit keeps a 'paid' the server set; an edit that moves the total is worked out again.
      syncInvoiceStatus(store, id, { moneyChanged: docTotals(before).totalCents !== docTotals(after).totalCents });
      drawStatus();
    },
    onPulled: (fields, clashes) => {
      if (clashes.length) ui.toast(`${doc.number} changed in QuickBooks or on another device while you were editing it. The latest version is shown; check your last change.`, 'info', 7000);
      if (fields.some((f) => FORM_FIELDS.includes(f)) || (doc.status === 'void') !== readOnly) { redraw(); return; }
      refreshPaid(); drawStatus();
    },
    onRemoved: () => { ui.toast(`${doc.number} was deleted on another device`, 'info', 4000); nav('#/invoices'); },
  });
  // Re-open the screen on the record as it now is, where it was scrolled to.
  const redraw = () => {
    if (typeof ctx.route !== 'function') { refreshPaid(); drawStatus(); return; }
    const top = root.scrollTop;
    ctx.route();
    root.scrollTop = top;
  };
  const paid = () => invoicePaidCents(store, id);
  const money = moneyFormatter(store.settings());
  const changed = () => { totals.update(doc); noTax.update(); save(); };

  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const fieldEl = (f, onVal) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); changed(); });
    return el;
  };
  const readOnly = doc.status === 'void';
  const taxNodes = taxEditor({ doc, store, onChange: changed, readOnly, dateKey: 'issueDate' });
  // "Why no tax?" (QuickBooks contract 8.5): every company; each reason lands on its own GST return line.
  const noTax = noTaxReasonPicker(ctx, doc, { onChange: () => save(), readOnly });
  const header = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Client', name: 'clientId', type: 'select', value: doc.clientId || '', options: ui.recordOptions(clients) }, (v) => { doc.clientId = v || null; }),
    fieldEl({ label: 'Job', name: 'jobId', type: 'select', value: doc.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) }, (v) => { doc.jobId = v || null; }),
    fieldEl({ label: 'Issue date', name: 'issueDate', type: 'date', value: doc.issueDate }, (v) => { doc.issueDate = v; taxNodes.recompute(); }),
    fieldEl({ label: 'Due date', name: 'dueDate', type: 'date', value: doc.dueDate }, (v) => { doc.dueDate = v; }),
    taxNodes, noTax);
  const notes = fieldEl({ label: 'Notes shown on the invoice', name: 'notes', type: 'textarea', value: doc.notes, span: true }, (v) => { doc.notes = v; });
  const editor = lineEditor({ doc, store, onChange: changed, readOnly });
  const totals = totalsPanel(doc, { showMarkup: false, paidCents: paid, money });
  const refreshPaid = () => totals.update(doc);

  const statusHost = h('div', { class: 'stack' });
  const paymentsHost = h('div');
  const drawStatus = () => {
    ui.clear(statusHost);
    const cur = store.get('invoices', id) || doc;
    const { status: st, balanceCents: bal } = invoiceShown(store, cur);
    h(statusHost, null,
      h('div', { class: 'row' }, h('strong', null, 'Status'), h('span', { class: 'grow' }), qboBadge(ctx, 'invoices', id, { detail: true, record: cur }), ui.statusBadge(st)),
      h('div', { class: 'row' },
        cur.status === 'draft' ? ui.button('Mark sent', { size: 'sm', icon: 'send', onClick: () => setStatus('sent') }) : null,
        cur.status !== 'void' && bal > 0 ? ui.button('Record payment', { size: 'sm', variant: 'primary', icon: 'dollar', onClick: recordPayment }) : null,
        cur.status !== 'void' ? ui.button('Void', { size: 'sm', variant: 'ghost danger', onClick: voidIt }) : ui.button('Restore', { size: 'sm', onClick: restore })),
      invoiceOnlineTools(ctx, cur, bal),
      cur.estimateId && moduleOn(store.settings(), 'estimates') ? ui.button('Source estimate', { size: 'sm', variant: 'ghost', icon: 'file-text', href: '#/estimates/' + cur.estimateId }) : null,
      cur.tm ? h('div', { class: 'muted', dataset: { tmInvoice: '1' } }, `${billingLabel('tm')}: ${(cur.tm.timeEntryIds || []).length} time entr${(cur.tm.timeEntryIds || []).length === 1 ? 'y' : 'ies'}, ${(cur.tm.stockMoveIds || []).length + (cur.tm.materialRequestIds || []).length} material record(s)${cur.tm.from || cur.tm.to ? `, ${cur.tm.from || '…'} to ${cur.tm.to || '…'}` : ''}. Voiding frees them to bill again.`) : null,
      cur.jobId ? ui.button('Open job', { size: 'sm', variant: 'ghost', icon: 'briefcase', href: '#/jobs/' + cur.jobId }) : null,
      cur.status === 'draft' ? lookupAction(ctx, { entity: 'invoices', clientId: cur.clientId }) : null);
  };
  const drawPayments = () => {
    ui.clear(paymentsHost);
    const pays = store.list('payments', (p) => p.invoiceId === id).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    // A settlement payment (credit memos or journals applied in QuickBooks, contract 4.9) is written
    // only by the QuickBooks sync: shown read-only, never edited or deleted here.
    paymentsHost.append(pays.length ? h('div', { class: 'list' }, pays.map((p) => (isSettlementPayment(p)
      ? h('div', { class: 'list-row', dataset: { settlement: '1' } },
        h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(p.amountCents)), h('div', { class: 'meta' }, [ui.fmtDate(p.date), SETTLEMENT_LABEL].filter(Boolean).join(' · '))),
        settlementNote(ui))
      : h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(p.amountCents)), h('div', { class: 'meta' }, [ui.fmtDate(p.date), p.method, p.reference].filter(Boolean).join(' · '))),
        qboBadge(ctx, 'payments', p.id, { record: p }),
        ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete payment', onClick: async () => {
          if (!(await ui.confirmDialog(`Delete the ${money(p.amountCents)} payment?`, { okLabel: 'Delete' }))) return;
          store.remove('payments', p.id); afterPayment();
        } })))))
      : h('p', { class: 'muted', style: { margin: 0 } }, 'No payments recorded.'));
  };
  // A payment added or deleted here: the status is worked out from the payments (moneyChanged).
  const afterPayment = () => { save.flush(); syncInvoiceStatus(store, id); refreshPaid(); drawStatus(); drawPayments(); };
  const setStatus = (st) => { save.write({ status: st }, { summary: `${doc.number} → ${st}` }); drawStatus(); ui.toast(`${doc.number} marked ${st}`, 'success'); };
  const voidIt = async () => {
    if (!(await ui.confirmDialog(`Void ${doc.number}? It stays on record but no longer counts as owed.`, { okLabel: 'Void' }))) return;
    setStatus('void'); nav('#/invoices/' + id);
  };
  // Voiding a T&M invoice freed its time and material; a newer invoice may have billed them since.
  const restore = () => {
    const clash = restoreConflicts(store.get('invoices', id), store.list('invoices'));
    if (clash.length) {
      ui.toast(`${doc.number} can't be restored: ${clash.length} of its time or material record${clash.length === 1 ? ' is' : 's are'} on a newer invoice now. Void that one first, or leave this one void.`, 'error', 6000);
      return;
    }
    setStatus('draft'); syncInvoiceStatus(store, id); nav('#/invoices/' + id);
  };
  const recordPayment = () => {
    save.flush();
    const bal = invoiceBalanceCents(store, store.get('invoices', id));
    ui.formSheet({
      title: `Record payment · ${doc.number}`,
      submitLabel: 'Record payment',
      fields: [
        { label: 'Amount', name: 'amountCents', type: 'money', value: Math.max(0, bal), required: true, hint: `Balance ${money(bal)}` },
        { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
        { label: 'Method', name: 'method', type: 'select', value: 'e-transfer', options: METHODS },
        { label: 'Reference', name: 'reference', placeholder: 'Cheque #, e-Transfer reference…' },
      ],
      onSubmit: (v) => {
        if (!(v.amountCents > 0)) { ui.toast('Enter an amount above zero', 'error'); return false; }
        store.add('payments', { invoiceId: id, ...v });
        afterPayment();
        ui.toast(`Payment of ${money(v.amountCents)} recorded`, 'success');
      },
    });
  };
  drawStatus(); drawPayments();
  // Payments that arrive from the server (Stripe, another device, a QuickBooks settlement).
  const offPayments = store.on('payments', (e) => {
    if (e?.remote && e.record?.invoiceId === id) { refreshPaid(); drawStatus(); drawPayments(); }
  });

  const remove = async () => {
    // Credited or paid in QuickBooks (4.9): that payment is QuickBooks', so the invoice stays; void it.
    if (store.count('payments', (p) => p.invoiceId === id && isSettlementPayment(p))) {
      ui.toast(`${doc.number} has a payment credited or paid in QuickBooks, which can't be deleted from Fishtape. Void the invoice instead.`, 'error', 6000);
      return;
    }
    const n = store.count('payments', (p) => p.invoiceId === id);
    if (!(await ui.confirmDialog(`Delete invoice ${doc.number}${n ? ` and its ${n} payment${n > 1 ? 's' : ''}` : ''}? Voiding keeps a record; deleting doesn't.`, { okLabel: 'Delete' }))) return;
    save.flush();
    for (const p of store.list('payments', (x) => x.invoiceId === id)) store.remove('payments', p.id);
    store.remove('invoices', id);
    ui.toast('Invoice deleted');
    nav('#/invoices');
  };

  root.append(ui.page({
    title: doc.number,
    subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / ', clientOrJob(store, doc)),
    actions: [
      // `extra` is a getter so the preview and the printout each get their own pay-link node.
      ui.button('Print / PDF', { icon: 'printer', onClick: () => { save.flush(); previewDocument({ kind: 'Invoice', doc, store, paidCents: paid(), get extra() { return payLinkBlock(store, id, docTotals(doc).totalCents - paid()); } }); } }),
      ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete invoice', onClick: remove }),
    ],
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      readOnly ? h('div', { class: 'card money-void' }, ui.badge('void', 'neutral'), ' This invoice is void and read-only.') : null,
      h('div', { class: 'card' }, header),
      h('div', { class: 'card' }, h('h3', null, 'Lines'), editor),
      h('div', { class: 'card' }, h('div', { class: 'form-grid' }, notes))),
    h('aside', { class: 'doc-side stack' },
      h('div', { class: 'card' }, statusHost),
      h('div', { class: 'card' }, h('h3', null, 'Totals'), totals),
      h('div', { class: 'card' }, h('h3', null, 'Payments'), paymentsHost)))));

  return () => { offPayments(); save.stop(); };
}

/** Invoice fields the detail screen shows in its form: changed elsewhere, the screen is drawn again. */
const FORM_FIELDS = ['number', 'clientId', 'jobId', 'issueDate', 'dueDate', 'taxes', 'taxPct', 'taxProvince', 'taxTreatment', 'taxNoneReason', 'notes', 'lines', 'title'];
