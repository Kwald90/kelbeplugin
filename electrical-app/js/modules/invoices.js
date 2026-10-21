// Invoices & payments (S18): list with ageing, builder, payments, print; and getting paid
// (docs/releases/r1-get-paid.md 4.3 to 4.7, 7.3 to 7.5; docs/office/getting-paid.md):
//   #/invoices/receive       one cheque across several invoices, on-account credit, "Apply credit"
//   #/invoices/statements    a client's statement (print, email)
//   #/invoices/collections   deposits, interest, reminder steps, the hold, closeout and prompt payment settings
//   #/invoices/ready         the ready-to-bill queue with invoice lag and DSO
//   #/invoices/new?kind=deposit|release   deposit and holdback release invoices
//   #/invoices/:id           disputes, credit notes and their application, back-charges, bad debt, deposits
//                            (apply, refund, keep), holdback, prompt payment dates, the period lock
import { docTotals, invoicePaidCents, invoiceShown, moneyFormatter, combinedPct, invoiceKind, creditNoteFrom, creditNoteBalance, holdbackProblem,
  holdbackSnapshot, holdbackReleaseLine, depositInvoiceLine, depositInvoiceFields, depositApplicationLine, sameTaxSet, DEPOSIT_NOTES, CREDIT_REASONS } from '../lib/money.js';
import { newDocTax, taxComponents, TREATMENTS } from '../lib/tax.js';
import { lineEditor, taxEditor, totalsPanel, previewDocument, clientName, confirmSend, ruleRows, printNode } from '../lib/doc-view.js';
import { invoiceOnlineTools, payLinkBlock } from './integrations.js';
import { moduleOn } from '../lib/modules.js';
import { billingLabel, restoreConflicts } from '../lib/tm.js';
import { qboBadge, noTaxReasonPicker, isSettlementPayment, isQuickBooksPayment, SETTLEMENT_LABEL, DEPOSIT_LABEL, settlementNote, lookupAction, needsNoTaxReason, nextInvoiceStatus, docEditor } from '../lib/qbo-ui.js';
import { isLocked, locksFrom, zoneFor, REVERSAL_ACTION } from '../lib/closing.js';
import * as R from '../lib/receivables.js';
import { promptPaymentDates, promptPaymentApplies, fmtDue, PP_DISCLAIMER, PP_CHECK_APPLIES } from '../lib/prompt-payment.js';
import { lineTaxOffProblem } from '../lib/exemption.js';

const METHODS = ['e-transfer', 'cheque', 'card', 'cash', 'transfer'];
const DELIVERY = [{ value: 'fishtape-email', label: 'Emailed from Fishtape' }, { value: 'email', label: 'Emailed (other)' }, { value: 'gc-portal', label: "Uploaded to the GC's portal" },
  { value: 'hand', label: 'By hand' }, { value: 'mail', label: 'By mail' }, { value: 'quickbooks', label: 'Sent from QuickBooks' }];
const REASON_LABEL = { error: 'Billing error', price: 'Price adjustment', dispute: 'Dispute conceded', backcharge: 'Back-charge', bad_debt: 'Bad debt', 'deposit-refund': 'Deposit refund', other: 'Other' };
const SUBS = ['new', 'receive', 'statements', 'collections', 'ready'];

export default {
  id: 'invoices',
  title: 'Invoices',
  icon: 'receipt',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (sub === 'new') { createNew(ctx); return; }
    if (sub === 'receive') return receiveView(root, ctx);
    if (sub === 'statements') return statementsView(root, ctx);
    if (sub === 'collections') return collectionsView(root, ctx);
    if (sub === 'ready') return readyView(root, ctx);
    if (sub && !SUBS.includes(sub)) return renderDetail(root, ctx, sub);
    return renderList(root, ctx);
  },
};

// Status and balance as the screens show them: lib/money.js invoiceShown (QuickBooks' tax rounding, 4.8).
export { invoiceShown };

/**
 * Recompute the stored status from payments (never touches void). `moneyChanged` false (an edit
 * that left the total as it was) keeps a 'paid' the server set within the tax rounding.
 */
export function syncInvoiceStatus(store, invId, { moneyChanged = true } = {}) {
  const inv = store.get('invoices', invId);
  if (!inv || inv.status === 'void' || invoiceKind(inv) === 'credit') return inv;
  const next = nextInvoiceStatus(inv, invoicePaidCents(store, invId), docTotals(inv).totalCents, { moneyChanged });
  if (next !== inv.status) return store.update('invoices', invId, { status: next }, { summary: `${inv.number} → ${next}` });
  return inv;
}

/** Ask the server to recompute a client's hold after a payment (online only; the daily run catches the rest). */
export function recheckHold(ctx, clientId) {
  if (!clientId) return;
  ctx.app?.api?.post?.(`/api/v1/receivables/recheck/${encodeURIComponent(clientId)}`, {}).catch(() => {});
}

const today = (ui) => ui.today();
const sources = (store) => ({
  jobs: store.list('jobs'), invoices: store.list('invoices'), payments: store.list('payments'), fieldTickets: store.list('fieldTickets'),
  timeEntries: store.list('timeEntries'), stockMoves: store.list('stockMoves'), materialRequests: store.list('materialRequests'),
  items: store.list('items'), employees: store.list('employees'), settings: store.settings(),
});
const subNav = (ui) => [
  ui.button('Receive payment', { icon: 'dollar', href: '#/invoices/receive' }),
  ui.button('Ready to bill', { icon: 'list', href: '#/invoices/ready' }),
  ui.button('Statements', { icon: 'file-text', href: '#/invoices/statements' }),
  ui.button('Collections', { icon: 'settings', href: '#/invoices/collections' }),
];

// ---------- list ----------
function renderList(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let tab = 'all', q = '';
  const host = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(host);
    const payments = store.list('payments');
    const all = store.list('invoices').map((inv) => {
      const { status, balanceCents: balance } = invoiceShown(store, inv);
      return { inv, status, total: docTotals(inv).totalCents, balance };
    });
    const open = all.filter((r) => !['void', 'draft', 'paid', 'applied'].includes(r.status) && r.balance > 0 && invoiceKind(r.inv) !== 'credit');
    // Ageing runs on what is collectible: disputed amounts and holdback the customer kept are on their own lines (4.4, 7.3).
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
    let disputed = 0, kept = 0;
    for (const r of open) {
      const c = R.collectibleCents(r.inv, payments);
      disputed += Math.min(r.balance, Math.max(0, R.openDisputesCents(r.inv)));
      kept += Math.min(Math.max(0, r.balance - R.openDisputesCents(r.inv)), R.retainedByCustomerCents(r.inv));
      const past = r.inv.dueDate ? -ui.daysUntil(r.inv.dueDate) : 0;
      if (past <= 0) buckets.current += c;
      else if (past <= 30) buckets.d30 += c;
      else if (past <= 60) buckets.d60 += c;
      else if (past <= 90) buckets.d90 += c;
      else buckets.d90p += c;
    }
    const aged = Object.values(buckets).reduce((s, v) => s + v, 0);
    const outstanding = open.reduce((s, r) => s + r.balance, 0);
    const overdue = aged - buckets.current;
    const money = moneyFormatter(store.settings());
    const m = (c) => money(c, { whole: true });
    h(host, null,
      h('div', { class: 'row money-subnav' }, subNav(ui)),
      h('div', { class: 'grid money-stats' },
        ui.stat({ label: 'Outstanding', value: m(outstanding), hint: `${open.length} open invoices`, tone: 'accent' }),
        ui.stat({ label: 'Overdue', value: m(overdue), hint: `${open.filter((r) => r.status === 'overdue').length} past due`, tone: overdue ? 'danger' : null }),
        ui.stat({ label: 'Collected (30 days)', value: m(payments.filter((p) => ui.daysUntil(p.date) >= -30 && p.method !== 'credit-note' && !p.appliedFromId).reduce((s, p) => s + p.amountCents, 0)), tone: 'success' })),
      h('div', { class: 'card ageing' },
        h('h3', null, 'Ageing'),
        h('div', { class: 'ageing-row' }, [
          ['Current', buckets.current], ['1–30 days', buckets.d30], ['31–60', buckets.d60], ['61–90', buckets.d90], ['90+', buckets.d90p],
        ].map(([label, v], i) => h('div', { class: ['ageing-cell', i && v ? 'late' : null] },
          h('span', { class: 'label' }, label), h('span', { class: 'value num' }, m(v)),
          h('div', { class: 'progress' }, h('i', { style: { width: aged ? `${Math.round((v / aged) * 100)}%` : '0%' } }))))),
        disputed || kept ? h('p', { class: 'muted money-aside' }, [disputed ? `In dispute ${m(disputed)}` : null, kept ? `Holdback kept by customers ${m(kept)}` : null].filter(Boolean).join(' · '), ' (not in ageing)') : null),
      h('div', { class: 'row' },
        ui.tabs([
          { id: 'all', label: `All ${all.length}` }, { id: 'open', label: `Open ${open.length}` },
          { id: 'overdue', label: `Overdue ${all.filter((r) => r.status === 'overdue').length}` },
          { id: 'paid', label: 'Paid' }, { id: 'draft', label: 'Draft' }, { id: 'credit', label: 'Credit notes' }, { id: 'void', label: 'Void' },
        ], tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }),
        ui.searchBox('Search invoices', (v) => { q = v; drawTable(); }, q)),
      tableHost);
    drawTable();

    function drawTable() {
      const n = q.trim().toLowerCase();
      const rows = all.filter((r) => {
        if (tab === 'open' && !open.includes(r)) return false;
        if (tab === 'credit') { if (invoiceKind(r.inv) !== 'credit') return false; } else if (!['all', 'open'].includes(tab) && r.status !== tab) return false;
        const job = r.inv.jobId ? store.get('jobs', r.inv.jobId) : null;
        return !n || [r.inv.number, clientName(store, r.inv.clientId), job?.title].some((s) => (s || '').toLowerCase().includes(n));
      });
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'number', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.inv.number, kindTag(ui, r.inv)), sort: (r) => r.inv.number },
          { key: 'client', label: 'Client / job', render: (r) => clientOrJob(store, r.inv), sort: (r) => clientOrJob(store, r.inv) },
          { key: 'issue', label: 'Issued', render: (r) => ui.fmtDate(r.inv.issueDate), sort: (r) => r.inv.issueDate || '' },
          { key: 'due', label: 'Due', render: (r) => ui.fmtDate(r.inv.dueDate), sort: (r) => r.inv.dueDate || '' },
          { key: 'total', label: 'Total', align: 'right', render: (r) => money(r.total), sort: (r) => r.total },
          { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance), sort: (r) => r.balance },
          { key: 'status', label: 'Status', render: (r) => h('span', { class: 'row-inline' }, ui.statusBadge(r.status), (r.inv.disputes || []).some((d) => (d.status || 'open') === 'open') ? ui.badge('disputed', 'warning') : null, qboBadge(ctx, 'invoices', r.inv.id, { record: r.inv })), sort: (r) => r.status },
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

const KIND_TAG = { deposit: 'deposit', progress: 'progress', 'holdback-release': 'holdback release', credit: 'credit note', interest: 'interest' };
function kindTag(ui, inv) {
  const k = invoiceKind(inv);
  return KIND_TAG[k] ? ui.h('span', { class: 'money-kind' }, ` ${KIND_TAG[k]}`) : null;
}

function clientOrJob(store, inv) {
  const c = inv.clientId ? store.get('clients', inv.clientId)?.name : null;
  const j = inv.jobId ? store.get('jobs', inv.jobId) : null;
  return [c, j ? `${j.number} ${j.title}` : null].filter(Boolean).join(' · ') || '—';
}

/** The terms the invoice snapshots: the company's terms text plus the interest sentence when interest is on (4.5). */
export function termsFields(settings) {
  const c = settings?.collections || {};
  const interest = R.interestTermsText(c.interest);
  const text = [String(c.termsText || '').trim(), interest].filter(Boolean).join(' ');
  return text ? { termsText: text.slice(0, 2000), interestDisclosed: Boolean(interest) } : {};
}

/** Days to pay: the client's terms, else the job's contract terms, else 14. */
const termsDays = (client, job) => [client?.credit?.termsDays, job?.contract?.paymentTermsDays].find((v) => Number.isInteger(v) && v >= 0) ?? 14;

/** Warn when a client is over its credit limit (4.6). */
function limitWarning(ctx, clientId) {
  const { store, ui } = ctx;
  const client = clientId ? store.get('clients', clientId) : null;
  const limit = client?.credit?.limitCents;
  if (!Number.isInteger(limit)) return;
  const exposure = R.creditExposure(client, { invoices: store.list('invoices'), payments: store.list('payments') });
  if (exposure > limit) ui.toast(`${client.name} is over its credit limit (${moneyFormatter(store.settings())(exposure, { whole: true })} owed or held against ${moneyFormatter(store.settings())(limit, { whole: true })}).`, 'error', 7000);
}

// ---------- new ----------
async function createNew(ctx) {
  const { store, ui, query } = ctx;
  const s = store.settings();
  const est = query.estimateId ? store.get('estimates', query.estimateId) : null;
  const job = query.jobId ? store.get('jobs', query.jobId) : est?.jobId ? store.get('jobs', est.jobId) : null;
  const clientId = est?.clientId || job?.clientId || query.clientId || null;
  const client = clientId ? store.get('clients', clientId) : null;
  const rec = {
    number: null, clientId, jobId: job?.id || null, estimateId: null, status: 'draft', lines: [],
    ...newDocTax(s, ui.today(), { job, client }), issueDate: ui.today(), dueDate: ui.today(termsDays(client, job)), notes: '', ...termsFields(s),
  };
  if (query.kind === 'deposit') {
    const made = await depositSheet(ctx, { job, est, rec });
    if (!made) { history.back(); return; }
  } else if (query.kind === 'release') {
    if (!job) { ui.toast('Open the job to invoice its holdback release', 'error'); history.back(); return; }
    const led = R.holdbackLedger(store.list('invoices'), { jobId: job.id });
    if (led.outstandingCents <= 0) { ui.toast(`${job.number} has no holdback left to release`, 'error'); history.back(); return; }
    const progress = store.list('invoices', (i) => i.jobId === job.id && i.status !== 'void' && i.holdback);
    const deferTaxIds = [...new Set(progress.flatMap((i) => i.holdback?.deferTaxIds || []))];
    const on = job.contract?.holdbackReleaseOn && job.contract.holdbackReleaseOn >= ui.today() ? job.contract.holdbackReleaseOn : ui.today();
    Object.assign(rec, { kind: 'holdback-release', holdbackInvoiceIds: led.byInvoice.map((b) => b.invoiceId), issueDate: on, dueDate: on, title: `Holdback release: ${job.title || job.number}` });
    rec.lines = [holdbackReleaseLine(led.outstandingCents, { taxes: rec.taxes, deferTaxIds })];
  } else if (est) {
    const t = docTotals(est);
    Object.assign(rec, { estimateId: est.id, notes: est.notes || '', title: est.title || '' });
    Object.assign(rec, invoiceTaxFromEstimate(est, rec));
    for (const k of ['taxExemptNumber', 'taxExemptBasis', 'taxExemptDetails', 'exemptionConfirmed']) if (est[k] !== undefined && est[k] !== null) rec[k] = JSON.parse(JSON.stringify(est[k]));
    rec.lines = (est.lines || []).map((l) => ({ ...l }));
    if (t.markupCents) rec.lines.push({ itemId: null, description: `Materials markup (${est.markupPct}%)`, qty: 1, unitCents: t.markupCents, labourHours: 0, kind: 'other' });
    // The estimate's "Why no tax?" reason comes along while the invoice is still untaxed.
    if (est.taxNoneReason && needsNoTaxReason(rec)) rec.taxNoneReason = est.taxNoneReason;
  } else if (job) {
    rec.title = job.title || '';
    const cos = R.unbilledChangeOrders(job, store.list('invoices'));
    if (cos.length && await ui.confirmDialog(`${job.number} has ${cos.length} approved change order${cos.length > 1 ? 's' : ''} not yet billed. Add ${cos.length > 1 ? 'them' : 'it'} to this invoice?`, { title: 'Bill change orders?', okLabel: 'Add', danger: false })) {
      rec.lines.push(...cos.map((c) => ({ itemId: null, changeOrderId: c.id, description: `Change order: ${c.title}`, qty: 1, unitCents: c.amountCents || 0, labourHours: 0, kind: 'other', ...(c.costCodeId ? { costCodeId: c.costCodeId } : {}) })));
      const ticketIds = cos.flatMap((c) => c.ticketIds || []);
      if (ticketIds.length) rec.ticketIds = ticketIds;
    }
    if (job.contract?.properInvoiceRequired) Object.assign(rec, { properInvoice: true, contractRef: job.contract.contractNo || null });
  }
  rec.number = store.nextNumber('invoice');
  const created = store.add('invoices', rec);
  limitWarning(ctx, clientId);
  location.replace('#/invoices/' + created.id);
}

/** "New deposit invoice": amount or % of the estimate, prepayment or security deposit (4.3). */
function depositSheet(ctx, { job, est, rec }) {
  const { store, ui } = ctx;
  const s = store.settings();
  const { h } = ui;
  return new Promise((resolve) => {
    let done = false;
    const model0 = s.deposits?.defaultModel === 'security' ? 'security' : 'prepayment';
    const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); submit(); } }, ui.formGrid([
      { label: 'Kind of deposit', name: 'model', type: 'select', value: model0, span: true, options: [{ value: 'prepayment', label: 'Prepayment (taxed now, credited on the final invoice)' }, { value: 'security', label: 'Security deposit (no tax until it is applied)' }] },
      est ? { label: '% of the estimate', name: 'pct', type: 'number', step: '0.1', min: '0', max: '100', value: s.deposits?.defaultPct ?? '' } : null,
      { label: est ? 'Or an amount' : 'Amount', name: 'cents', type: 'money', value: null, hint: est ? 'Leave blank to use the %' : 'Before tax for a prepayment' },
    ].filter(Boolean)));
    const submit = () => {
      const v = ui.readForm(form);
      let cents = v.cents;
      if (!(cents > 0) && est && Number(v.pct) > 0) {
        const t = docTotals(est);
        // A prepayment is taxed on the deposit invoice: take the % of the estimate before tax.
        cents = Math.round(((v.model === 'security' ? t.totalCents : t.subtotalCents) * Number(v.pct)) / 100);
      }
      if (!(cents > 0)) { ui.toast('Enter an amount or a %', 'error'); return; }
      const model = v.model === 'security' ? 'security' : 'prepayment';
      Object.assign(rec, depositInvoiceFields(model), {
        title: `Deposit${est ? ` on ${est.number}` : job ? ` on ${job.number}` : ''}`,
        notes: model === 'security' ? `${DEPOSIT_NOTES.security} VERIFY with your accountant that RST follows the same timing.` : DEPOSIT_NOTES.prepayment,
        lines: [depositInvoiceLine({ cents, model, ref: est?.number || job?.number || '' })], ...(est ? { estimateId: est.id } : {}),
      });
      done = true; resolve(true); sheet.close();
    };
    const sheet = ui.openSheet({
      title: `New deposit invoice${est ? ` on ${est.number}` : job ? ` on ${job.number}` : ''}`, body: form,
      actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Create deposit invoice', { variant: 'primary', onClick: submit })],
      onClose: () => { if (!done) resolve(false); },
    });
  });
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

// ---------- credit notes (2.6, 4.4) ----------

/**
 * A credit note for an amount (tax included) against an invoice: one line before tax, taxed like the
 * original, so its total is the amount within a cent. Status 'sent' (a document to keep), numbered CR-.
 */
export function creditNoteForAmount(store, inv, cents, { reason = 'other', description = '', today: day, status = 'sent' } = {}) {
  // A security deposit was invoiced tax-free (line taxOff ['*'], Excise Tax Act s.168(9)), so its
  // refund must mirror that: the refund amount is the base with no gross-up and the line carries no
  // tax. A prepayment deposit, a dispute or a back-charge WAS taxed, so it keeps the taxed path.
  const security = inv?.depositModel === 'security';
  const base = security ? Math.round(cents) : R.baseForAmount(inv, cents);
  const line ={ itemId: null, kind: 'other', description: description || REASON_LABEL[reason] || 'Credit', qty: 1, unitCents: base, labourHours: 0, ...(security ? { taxOff: ['*'] } : {}) };
  const note = creditNoteFrom({ ...inv, holdback: null, markupPct: 0 }, { lines: [line], reason, today: day, settings: store.settings() });
  delete note.holdback;
  if (inv.holdback && docTotals(inv).holdbackCents) {
    // Credit the work before holdback in proportion, so the holdback ledger shrinks with it.
    const full = creditNoteFrom(inv, { lines: [line], reason, today: day, settings: store.settings() });
    if (full.holdback) note.holdback = full.holdback;
  }
  return { ...note, number: store.nextNumber('credit'), status };
}

/** Apply a credit note to an invoice: a payment { method 'credit-note', creditNoteId } (2.6). */
export function applyCreditNote(store, note, invoiceId, cents, day) {
  const amount = Math.round(cents);
  if (!(amount > 0)) return null;
  const pay = store.add('payments', { invoiceId, creditNoteId: note.id, method: 'credit-note', amountCents: amount, date: day, reference: note.number || '' }, { summary: `${note.number} applied` });
  syncInvoiceStatus(store, invoiceId);
  return pay;
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
  const settings = store.settings();
  const kind = invoiceKind(doc);
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
      refreshPaid(); drawStatus(); drawSide();
    },
    onRemoved: () => { ui.toast(`${doc.number} was deleted on another device`, 'info', 4000); nav('#/invoices'); },
  });
  // Re-open the screen on the record as it now is, where it was scrolled to.
  const redraw = () => {
    if (typeof ctx.route !== 'function') { refreshPaid(); drawStatus(); drawSide(); return; }
    const top = root.scrollTop;
    ctx.route();
    root.scrollTop = top;
  };
  const paid = () => invoicePaidCents(store, id);
  const money = moneyFormatter(settings);
  const changed = () => { totals.update(doc); noTax.update(); save(); drawSide(); };

  // The period lock (2.6, 8.1): a record dated in a closed month is read-only; it changes by a credit note.
  const locks = locksFrom(settings, store.list('payrollRuns'));
  const zone = zoneFor(doc.taxProvince || settings.company?.province);
  const locked = isLocked(locks, 'invoices', doc, { zone });
  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const readOnly = doc.status === 'void' || locked;
  const fieldEl = (f, onVal) => {
    const el = ui.field({ ...f, readonly: readOnly || undefined });
    const c = el.querySelector('[name]');
    if (readOnly && c) c.disabled = true;
    c.addEventListener(c.tagName === 'SELECT' || c.type === 'checkbox' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); changed(); });
    return el;
  };
  const taxNodes = taxEditor({ doc, store, onChange: changed, readOnly, dateKey: 'issueDate' });
  // "Why no tax?" (QuickBooks contract 8.5): every company; each reason lands on its own GST return line.
  const noTax = noTaxReasonPicker(ctx, doc, { onChange: () => save(), readOnly });
  const header = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Client', name: 'clientId', type: 'select', value: doc.clientId || '', options: ui.recordOptions(clients) }, (v) => { doc.clientId = v || null; }),
    fieldEl({ label: 'Job', name: 'jobId', type: 'select', value: doc.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) }, (v) => { doc.jobId = v || null; taxNodes.refreshExemption?.(); }),
    fieldEl({ label: 'Issue date', name: 'issueDate', type: 'date', value: doc.issueDate }, (v) => { doc.issueDate = v; taxNodes.recompute(); }),
    fieldEl({ label: 'Due date', name: 'dueDate', type: 'date', value: doc.dueDate }, (v) => { doc.dueDate = v; }),
    taxNodes, noTax);
  const notes = fieldEl({ label: 'Notes shown on the invoice', name: 'notes', type: 'textarea', value: doc.notes, span: true }, (v) => { doc.notes = v; });
  const editor = lineEditor({ doc, store, onChange: changed, readOnly: readOnly || ['holdback-release', 'interest'].includes(kind) });
  const totals = totalsPanel(doc, { showMarkup: false, paidCents: paid, money });
  const refreshPaid = () => totals.update(doc);
  const job = () => (doc.jobId ? store.get('jobs', doc.jobId) : null);

  // Proper invoice fields (7.4): period, contract reference; delivery is recorded on the side.
  const proper = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Proper invoice (prompt payment)', name: 'properInvoice', type: 'checkbox', value: Boolean(doc.properInvoice || job()?.contract?.properInvoiceRequired) }, (v) => { doc.properInvoice = v; }),
    fieldEl({ label: 'Contract reference', name: 'contractRef', value: doc.contractRef || job()?.contract?.contractNo || '' }, (v) => { doc.contractRef = v || null; }),
    fieldEl({ label: 'Period from', name: 'periodFrom', type: 'date', value: doc.periodFrom || '' }, (v) => { doc.periodFrom = v || null; }),
    fieldEl({ label: 'Period to', name: 'periodTo', type: 'date', value: doc.periodTo || '' }, (v) => { doc.periodTo = v || null; }));

  const statusHost = h('div', { class: 'stack' });
  const paymentsHost = h('div');
  const sideHost = h('div', { class: 'stack' });
  const drawStatus = () => {
    ui.clear(statusHost);
    const cur = store.get('invoices', id) || doc;
    const { status: st, balanceCents: bal } = invoiceShown(store, cur);
    h(statusHost, null,
      h('div', { class: 'row' }, h('strong', null, 'Status'), h('span', { class: 'grow' }), qboBadge(ctx, 'invoices', id, { detail: true, record: cur }), ui.statusBadge(st)),
      locked ? h('div', { class: 'money-locked', dataset: { locked: '1' } }, ui.icon('lock', 16), ` In a closed period (through ${locks.booksThrough}). Changes are made by a credit note.`) : null,
      // A change the server refused (holdback_invalid, tax_off_invalid, exemption_required...): shown where it happened.
      ...(store.queue || []).filter((q) => q.collection === 'invoices' && q.id === id && q.state === 'rejected').slice(-1).map((q) => h('p', { class: 'money-warn', dataset: { rejected: q.error?.code || 'rejected' } },
        ui.icon('alert', 14), ` Not saved on the server: ${q.error?.message || 'refused'}${q.error?.details?.line != null ? ` (line ${q.error.details.line + 1})` : ''}`)),
      h('div', { class: 'row money-actions' },
        cur.status === 'draft' ? ui.button('Mark sent', { size: 'sm', icon: 'send', onClick: markSent }) : null,
        cur.status !== 'void' && bal > 0 && kind !== 'credit' ? ui.button('Record payment', { size: 'sm', variant: 'primary', icon: 'dollar', onClick: recordPayment }) : null,
        kind === 'credit' && cur.status !== 'void' && creditNoteBalance(cur, store.list('payments')) < 0 ? ui.button('Apply to invoice', { size: 'sm', variant: 'primary', onClick: applyNoteSheet }) : null,
        locked && cur.status !== 'void' && kind !== 'credit' ? ui.button(REVERSAL_ACTION.invoices, { size: 'sm', onClick: () => creditSheet('error') }) : null,
        cur.status !== 'void' && !locked ? ui.button('Void', { size: 'sm', variant: 'ghost danger', onClick: voidIt }) : null,
        cur.status === 'void' ? ui.button('Restore', { size: 'sm', onClick: restore }) : null),
      invoiceOnlineTools(ctx, cur, bal),
      cur.estimateId && moduleOn(settings, 'estimates') ? ui.button('Source estimate', { size: 'sm', variant: 'ghost', icon: 'file-text', href: '#/estimates/' + cur.estimateId }) : null,
      cur.creditsInvoiceId ? ui.button(`Credits ${store.get('invoices', cur.creditsInvoiceId)?.number || 'the invoice'}`, { size: 'sm', variant: 'ghost', icon: 'receipt', href: '#/invoices/' + cur.creditsInvoiceId }) : null,
      cur.tm ? h('div', { class: 'muted', dataset: { tmInvoice: '1' } }, `${billingLabel('tm')}: ${(cur.tm.timeEntryIds || []).length} time entr${(cur.tm.timeEntryIds || []).length === 1 ? 'y' : 'ies'}, ${(cur.tm.stockMoveIds || []).length + (cur.tm.materialRequestIds || []).length} material record(s)${cur.tm.from || cur.tm.to ? `, ${cur.tm.from || '…'} to ${cur.tm.to || '…'}` : ''}. Voiding frees them to bill again.`) : null,
      cur.jobId ? ui.button('Open job', { size: 'sm', variant: 'ghost', icon: 'briefcase', href: '#/jobs/' + cur.jobId }) : null,
      cur.status === 'draft' ? lookupAction(ctx, { entity: 'invoices', clientId: cur.clientId }) : null);
  };
  const drawPayments = () => {
    ui.clear(paymentsHost);
    const pays = store.list('payments', (p) => p.invoiceId === id || (kind === 'credit' && p.creditNoteId === id)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    // A settlement payment (credit memos or journals applied in QuickBooks, contract 4.9) and a
    // QuickBooks deposit (4.7) are written only by the QuickBooks sync: read-only here.
    const what = (p) => [ui.fmtDate(p.date), p.method === 'credit-note' ? `credit note ${store.get('invoices', p.creditNoteId)?.number || ''}${p.creditNoteId === id ? ` on ${store.get('invoices', p.invoiceId)?.number || ''}` : ''}` : p.appliedFromId ? 'on-account credit' : p.method, p.reference].filter(Boolean).join(' · ');
    paymentsHost.append(pays.length ? h('div', { class: 'list' }, pays.map((p) => (isQuickBooksPayment(p)
      ? h('div', { class: 'list-row', dataset: { settlement: '1' } },
        h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(p.amountCents)), h('div', { class: 'meta' }, [ui.fmtDate(p.date), isSettlementPayment(p) ? SETTLEMENT_LABEL : DEPOSIT_LABEL].filter(Boolean).join(' · '))),
        settlementNote(ui))
      : h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(p.amountCents)), h('div', { class: 'meta' }, what(p))),
        qboBadge(ctx, 'payments', p.id, { record: p }),
        isLocked(locks, 'payments', p, { zone }) ? h('span', { class: 'muted', title: 'In a closed period' }, ui.icon('lock', 16)) : ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete payment', onClick: async () => {
          if (!(await ui.confirmDialog(`Delete the ${money(p.amountCents)} payment?`, { okLabel: 'Delete' }))) return;
          store.remove('payments', p.id); afterPayment();
        } })))))
      : h('p', { class: 'muted', style: { margin: 0 } }, 'No payments recorded.'));
  };
  // A payment added or deleted here: the status is worked out from the payments (moneyChanged).
  const afterPayment = () => { save.flush(); syncInvoiceStatus(store, id); refreshPaid(); drawStatus(); drawPayments(); drawSide(); recheckHold(ctx, doc.clientId); };
  const setStatus = (st, extra = {}) => { save.write({ status: st, ...extra }, { summary: `${doc.number} → ${st}` }); drawStatus(); ui.toast(`${doc.number} marked ${st}`, 'success'); };
  // Leaving draft runs the send check (exemption evidence, holdback) the server runs too (2.9).
  const markSent = async () => {
    save.flush();
    const cur = store.get('invoices', id) || doc;
    // The server refuses a line that turns PST/RST off outside an out-of-pocket line (422 tax_off_invalid).
    const off = lineTaxOffProblem(cur);
    if (off) { ui.toast(`Line ${off.index + 1}: ${off.message}`, 'error', 6000); return; }
    if (!(await confirmSend(cur, { collection: 'invoices' }))) return;
    setStatus('sent', { sentAt: cur.sentAt || new Date().toISOString() });
    // Tickets this invoice bills are billed now (4.1).
    for (const tid of cur.ticketIds || []) {
      const t = store.get('fieldTickets', tid);
      if (t && ['signed', 'refused', 'priced'].includes(t.status)) store.update('fieldTickets', tid, { status: 'billed', invoiceId: id }, { summary: `${t.number || 'Ticket'} billed on ${cur.number}` });
    }
    if ((cur.properInvoice || job()?.contract?.properInvoiceRequired) && !cur.promptPayment?.deliveredOn) deliverySheet();
  };
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
    const cur = store.get('invoices', id);
    const bal = invoiceShown(store, cur).balanceCents;
    const c = R.collectibleCents(cur, store.list('payments'));
    const credits = R.onAccountCredits(cur.clientId, store.list('payments'));
    ui.formSheet({
      title: `Record payment · ${doc.number}`,
      submitLabel: 'Record payment',
      fields: [
        { label: 'Amount', name: 'amountCents', type: 'money', value: Math.max(0, c || bal), required: true, hint: `Balance ${money(bal)}${c !== bal ? `; ${money(c)} collectible (disputes and holdback kept are left out)` : ''}` },
        { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
        { label: 'Method', name: 'method', type: 'select', value: 'e-transfer', options: METHODS },
        { label: 'Reference', name: 'reference', placeholder: 'Cheque #, e-Transfer reference…' },
      ],
      extra: credits.length ? h('p', { class: 'muted' }, `${clientName(store, cur.clientId)} has ${money(credits.reduce((s, x) => s + x.availableCents, 0))} on account. Use "Apply credit" on Receive payment to use it.`) : null,
      onSubmit: (v) => {
        if (!(v.amountCents > 0)) { ui.toast('Enter an amount above zero', 'error'); return false; }
        store.add('payments', { invoiceId: id, clientId: cur.clientId || null, ...v });
        afterPayment();
        ui.toast(`Payment of ${money(v.amountCents)} recorded`, 'success');
      },
    });
  };

  // ---- credit notes, disputes, back-charges, bad debt (2.6, 4.4) ----
  const creditSheet = (reason0 = 'error') => {
    save.flush();
    const cur = store.get('invoices', id);
    const bal = Math.max(0, invoiceShown(store, cur).balanceCents);
    ui.formSheet({
      title: `Credit note for ${cur.number}`, submitLabel: 'Create credit note',
      fields: [
        { label: 'Reason', name: 'reason', type: 'select', value: reason0, options: CREDIT_REASONS.filter((r) => r !== 'deposit-refund' || kind === 'deposit').map((r) => ({ value: r, label: REASON_LABEL[r] })) },
        { label: 'Amount, tax included', name: 'cents', type: 'money', value: reason0 === 'bad_debt' ? bal : null, required: true },
        { label: 'Description', name: 'description', span: true, placeholder: 'What is credited and why' },
        { label: 'Apply it to this invoice now', name: 'apply', type: 'checkbox', value: true },
      ],
      onSubmit(v) {
        if (!(v.cents > 0)) { ui.toast('Enter the amount to credit', 'error'); return false; }
        const note = store.add('invoices', creditNoteForAmount(store, cur, v.cents, { reason: v.reason, description: v.description, today: ui.today() }));
        if (v.apply && bal > 0) applyCreditNote(store, note, id, Math.min(-docTotals(note).totalCents, bal), ui.today());
        afterPayment();
        ui.toast(`${note.number} created${v.apply ? ' and applied' : ''}`, 'success');
        if (v.reason === 'bad_debt') ui.toast('Flagged for your accountant: GST s.231 adjustment and the Manitoba RST bad-debt refund (VERIFY).', 'info', 7000);
      },
    });
  };
  const applyNoteSheet = () => {
    const note = store.get('invoices', id);
    const left = -creditNoteBalance(note, store.list('payments'));
    const targets = store.list('invoices', (i) => i.clientId === note.clientId && invoiceKind(i) !== 'credit' && !['void', 'draft'].includes(i.status) && invoiceShown(store, i).balanceCents > 0);
    if (!targets.length) { ui.toast('This client has no open invoice to apply it to', 'info'); return; }
    ui.formSheet({
      title: `Apply ${note.number}`, submitLabel: 'Apply',
      fields: [
        { label: 'Invoice', name: 'invoiceId', type: 'select', value: note.creditsInvoiceId && targets.some((t) => t.id === note.creditsInvoiceId) ? note.creditsInvoiceId : targets[0].id, options: targets.map((t) => ({ value: t.id, label: `${t.number} · ${money(invoiceShown(store, t).balanceCents)} open` })) },
        { label: 'Amount', name: 'cents', type: 'money', value: left, required: true, hint: `${money(left)} left to apply` },
      ],
      onSubmit(v) {
        const target = store.get('invoices', v.invoiceId);
        const max = Math.min(left, invoiceShown(store, target).balanceCents);
        if (!(v.cents > 0) || v.cents > max) { ui.toast(`Apply between $0.01 and ${money(max)}`, 'error'); return false; }
        applyCreditNote(store, note, v.invoiceId, v.cents, ui.today());
        drawStatus(); drawPayments(); refreshPaid();
        ui.toast(`${note.number} applied to ${target.number}`, 'success');
      },
    });
  };
  const disputeSheet = () => {
    const cur = store.get('invoices', id);
    ui.formSheet({
      title: `Record a dispute · ${cur.number}`, submitLabel: 'Record dispute',
      fields: [
        { label: 'Amount the customer did not pay', name: 'cents', type: 'money', required: true },
        { label: 'Line', name: 'lineIndex', type: 'select', value: '', options: [{ value: '', label: 'The whole invoice' }, ...(cur.lines || []).map((l, i) => ({ value: String(i), label: `${i + 1}. ${String(l.description || '').slice(0, 60)}` }))] },
        { label: 'Reason', name: 'reason', type: 'textarea', required: true, span: true, rows: 2 },
      ],
      onSubmit(v) {
        if (!(v.cents > 0)) { ui.toast('Enter the disputed amount', 'error'); return false; }
        const d = { id: `d-${Date.now().toString(36)}`, ...(v.lineIndex !== '' ? { lineIndex: Number(v.lineIndex) } : {}), cents: v.cents, reason: v.reason.trim().slice(0, 500), status: 'open', openedAt: new Date().toISOString(), openedBy: ctx.auth.who().name };
        save.write({ disputes: [...(cur.disputes || []), d] }, { summary: `${cur.number}: dispute recorded` });
        drawSide(); drawStatus();
      },
    });
  };
  const resolveDispute = async (d, outcome) => {
    const cur = store.get('invoices', id);
    let creditNoteId = null;
    if (outcome === 'conceded') {
      if (!(await ui.confirmDialog(`Concede ${money(d.cents)}? A credit note for it is made and applied to ${cur.number}.`, { title: 'Concede the dispute', okLabel: 'Concede', danger: false }))) return;
      const note = store.add('invoices', creditNoteForAmount(store, cur, d.cents, { reason: 'dispute', description: `Dispute conceded: ${d.reason || ''}`.trim(), today: ui.today() }));
      applyCreditNote(store, note, id, Math.min(-docTotals(note).totalCents, Math.max(0, invoiceShown(store, cur).balanceCents)), ui.today());
      creditNoteId = note.id;
    }
    const disputes = (store.get('invoices', id).disputes || []).map((x) => (x.id === d.id ? { ...x, status: outcome, resolvedAt: new Date().toISOString(), resolvedBy: ctx.auth.who().name, ...(creditNoteId ? { creditNoteId } : {}) } : x));
    save.write({ disputes }, { summary: `${cur.number}: dispute ${outcome}` });
    afterPayment();
  };

  // ---- deposits (4.3) ----
  const applyDepositsSheet = () => {
    save.flush();
    const cur = store.get('invoices', id);
    const avail = R.depositsAvailable(store.list('invoices'), store.list('payments'), { jobId: cur.jobId, clientId: cur.clientId }).filter((d) => d.availableCents > 0 && d.invoiceId !== id);
    if (!avail.length) { ui.toast('No paid deposits left to apply on this job or client', 'info'); return; }
    const rows = avail.map((d) => {
      const dep = store.get('invoices', d.invoiceId);
      const ok = d.model === 'security' || sameTaxSet(dep, cur);
      const input = h('input', { class: 'input num', type: 'number', step: '0.01', min: '0', value: ok ? (d.availableCents / 100).toFixed(2) : '0', disabled: !ok, 'aria-label': `Apply from ${d.number}` });
      return { d, dep, ok, input };
    });
    const sheet = ui.openSheet({
      title: 'Apply deposits', wide: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Paid deposits on this job (and the client\'s deposits with no job). A prepayment is applied before tax and taxed like it was, so tax is not charged twice.'),
        h('div', { class: 'list' }, rows.map((r) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `${r.d.number} · ${r.d.model}`), h('div', { class: 'meta' }, `${money(r.d.availableCents)} left${r.ok ? '' : ' · different tax set: issue a credit note against the deposit and a new invoice instead'}`)),
          r.input)))),
      actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Apply', { variant: 'primary', onClick: () => {
        const add = [];
        for (const r of rows) {
          const cents = ui.parseMoney(r.input.value);
          if (!r.ok || !(cents > 0)) continue;
          if (cents > r.d.availableCents) { ui.toast(`At most ${money(r.d.availableCents)} from ${r.d.number}`, 'error'); return; }
          add.push(depositApplicationLine(r.dep, cents));
        }
        if (!add.length) { sheet.close(); return; }
        doc.lines = [...(doc.lines || []), ...add];
        save(); save.flush(); sheet.close(); redraw();
      } })],
    });
  };
  const refundSheet = () => {
    const dep = store.get('invoices', id);
    const cash = store.list('payments', (p) => p.invoiceId === id && p.method !== 'credit-note').reduce((s, p) => s + (Number(p.amountCents) || 0), 0);
    if (!(cash > 0)) { ui.toast('Nothing was paid on this deposit', 'info'); return; }
    ui.formSheet({
      title: `Refund ${dep.number}`, submitLabel: 'Record refund',
      fields: [
        { label: 'Amount refunded', name: 'cents', type: 'money', value: cash, required: true, hint: `${money(cash)} was paid` },
        { label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true },
        { label: 'How', name: 'method', type: 'select', value: 'cheque', options: METHODS },
        { label: 'Reference', name: 'reference' },
      ],
      onSubmit(v) {
        if (!(v.cents > 0) || v.cents > cash) { ui.toast(`Refund between $0.01 and ${money(cash)}`, 'error'); return false; }
        const note = store.add('invoices', creditNoteForAmount(store, dep, v.cents, { reason: 'deposit-refund', description: `Refund of deposit ${dep.number}`, today: v.date }));
        applyCreditNote(store, note, id, -docTotals(note).totalCents, v.date);
        store.add('payments', { invoiceId: id, clientId: dep.clientId || null, method: 'refund', amountCents: -v.cents, date: v.date, reference: v.reference || '' }, { summary: `${dep.number} refunded` });
        afterPayment();
        ui.toast(`Refund of ${money(v.cents)} recorded with ${note.number}`, 'success');
      },
    });
  };
  const forfeit = async () => {
    const dep = store.get('invoices', id);
    const sec = dep.depositModel === 'security';
    if (!(await ui.confirmDialog(`Keep ${dep.number}? The customer cancelled and the deposit is not refunded.${sec ? ' A kept security deposit may be taxable: ask your accountant (Excise Tax Act s.182, VERIFY). No tax is worked out here.' : ' A kept prepayment counts as revenue today.'}`, { title: 'Keep the deposit', okLabel: 'Keep deposit', danger: false }))) return;
    save.write({ forfeitedOn: ui.today() }, { summary: `${dep.number}: deposit kept` });
    drawSide();
  };

  // ---- holdback (7.3) ----
  const holdbackCard = () => {
    const cur = store.get('invoices', id) || doc;
    if (!['standard', 'progress'].includes(kind)) return null;
    const t = docTotals(cur);
    const j = job();
    const hb = cur.holdback;
    if (cur.status === 'draft' && !locked) {
      const pct = h('input', { class: 'input num', type: 'number', step: '0.5', min: '0', max: '100', value: hb?.pct ?? '', placeholder: String(j?.contract?.holdbackPct ?? ''), 'aria-label': 'Holdback %' });
      const problem = holdbackProblem(cur);
      return h('div', { class: 'card', dataset: { holdbackCard: '1' } }, h('h3', null, 'Holdback'),
        h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, 'Holdback %'), pct),
          ui.button(hb ? 'Update' : 'Take holdback', { size: 'sm', onClick: () => {
            const v = pct.value === '' ? Number(j?.contract?.holdbackPct) : Number(pct.value);
            if (!(v > 0)) { ui.toast('Enter the holdback %', 'error'); return; }
            doc.holdback = holdbackSnapshot(doc, { pct: v, rules: ruleRows(store) });
            if (kind === 'standard' && j?.contract?.valueCents != null) doc.kind = 'progress';
            changed(); redraw();
          } }),
          hb ? ui.button('Remove', { size: 'sm', variant: 'ghost', onClick: () => { doc.holdback = null; changed(); redraw(); } }) : null),
        hb ? h('p', { class: 'muted' }, `Retained ${money(t.holdbackCents)} before tax${hb.deferTaxIds?.length ? `; ${hb.deferTaxIds.join(' and ')} on it are charged at release` : ''}.`) : null,
        problem ? h('p', { class: 'money-warn' }, ui.icon('alert', 14), ' ', problem.message) : null);
    }
    if (hb && t.holdbackCents) return h('div', { class: 'card' }, h('h3', null, 'Holdback'), h('p', { class: 'muted' }, `Retained ${money(t.holdbackCents)} (${hb.pct ?? ''}%). Released by a holdback release invoice from the job.`));
    if (!['draft', 'void'].includes(cur.status)) {
      const kept = R.retainedByCustomerCents(cur);
      return h('div', { class: 'card', dataset: { retainedCard: '1' } }, h('h3', null, 'Holdback the customer kept'),
        kept ? h('p', null, `${money(kept)} kept by the customer, recorded ${ui.fmtDate(cur.holdback?.retainedRecordedAt)}. It stays owed on this invoice, out of ageing and reminders.`) : h('p', { class: 'muted' }, 'If the general contractor held back part of this invoice on its own, record it here.'),
        ui.button(kept ? 'Change' : 'Customer retained holdback', { size: 'sm', onClick: () => ui.formSheet({
          title: 'Customer retained holdback', submitLabel: 'Save',
          fields: [{ label: 'Amount retained', name: 'cents', type: 'money', value: kept || Math.round(docTotals(cur).totalCents * (Number(j?.contract?.holdbackPct) || 10) / 100), required: true }],
          onSubmit(v) {
            save.write({ holdback: { ...(cur.holdback || {}), retainedByCustomerCents: Math.max(0, v.cents), retainedRecordedAt: new Date().toISOString(), retainedRecordedBy: ctx.auth.who().name } }, { summary: `${cur.number}: holdback kept by the customer` });
            drawSide();
          },
        }) }));
    }
    return null;
  };

  // ---- prompt payment (7.4, 7.5) ----
  const deliverySheet = () => {
    const cur = store.get('invoices', id);
    const pp = cur.promptPayment || {};
    ui.formSheet({
      title: 'When and how was this delivered?', submitLabel: 'Save',
      fields: [
        { label: 'Delivered on', name: 'deliveredOn', type: 'date', value: pp.deliveredOn || (cur.sentAt ? ui.localDay(cur.sentAt) : ui.today()), required: true },
        { label: 'How', name: 'deliveredVia', type: 'select', value: pp.deliveredVia || 'email', options: DELIVERY },
      ],
      onSubmit(v) { save.write({ promptPayment: { ...pp, ...v } }, { summary: `${cur.number}: delivery recorded` }); drawSide(); },
    });
  };
  const nonPaymentSheet = () => {
    const cur = store.get('invoices', id);
    const pp = cur.promptPayment || {};
    ui.formSheet({
      title: 'Record notice of non-payment', submitLabel: 'Save',
      fields: [
        { label: 'Received on', name: 'receivedOn', type: 'date', value: pp.nonPaymentNotice?.receivedOn || ui.today(), required: true },
        { label: 'Amount disputed', name: 'disputedCents', type: 'money', value: pp.nonPaymentNotice?.disputedCents ?? null },
        { label: 'Reason given', name: 'reason', type: 'textarea', span: true, rows: 2, value: pp.nonPaymentNotice?.reason || '' },
      ],
      onSubmit(v) { save.write({ promptPayment: { ...pp, nonPaymentNotice: { receivedOn: v.receivedOn, disputedCents: v.disputedCents || 0, reason: v.reason || null } } }, { summary: `${cur.number}: notice of non-payment` }); drawSide(); },
    });
  };
  const gcPaidSheet = () => {
    const cur = store.get('invoices', id);
    const pp = cur.promptPayment || {};
    ui.formSheet({
      title: 'The owner paid the general contractor', submitLabel: 'Save',
      fields: [{ label: 'GC was paid on', name: 'gcPaidOn', type: 'date', value: pp.gcPaidOn || ui.today(), required: true }],
      onSubmit(v) { save.write({ promptPayment: { ...pp, gcPaidOn: v.gcPaidOn } }, { summary: `${cur.number}: GC paid` }); drawSide(); },
    });
  };
  const promptCard = () => {
    const cur = store.get('invoices', id) || doc;
    const j = job();
    if (!j?.contract?.role || ['draft', 'void'].includes(cur.status) || ['credit', 'interest', 'deposit'].includes(kind)) return null;
    const rules = ruleRows(store);
    const emailed = store.list('outbox', (o) => o.relatedId === id && o.kind === 'invoice' && o.status === 'sent' && (o.sentAt || o.updatedAt)).map((o) => ui.localDay(o.sentAt || o.updatedAt)).sort()[0] || null;
    const a = promptPaymentApplies(j, cur, rules, { companyProvince: settings.company?.province });
    const d = promptPaymentDates(cur, j, rules, { companyProvince: settings.company?.province, emailedOn: emailed });
    const pp = cur.promptPayment || {};
    const row = (label, day, mayMove) => (day ? h('div', { class: 'totals-row' }, h('span', null, label), h('strong', null, fmtDue(day, mayMove))) : null);
    return h('div', { class: 'card', dataset: { promptPayment: '1' } }, h('h3', null, 'Prompt payment'),
      !rules.length ? h('p', { class: 'muted' }, 'The rules table loads when you\'re signed in (open Books → Rules once online).') : null,
      h('p', { class: 'muted' }, a.why),
      a.applies ? h('div', { class: 'totals' },
        row('Delivered', d.deliveredOn, false),
        row('Notice of non-payment due', d.noticeDueOn, d.mayMove.noticeDueOn),
        row('Payment due', d.paymentDueOn, d.mayMove.paymentDueOn),
        row('GC must pay you by', d.gcDueOn, d.mayMove.gcDueOn),
        d.expectedLatestOn && !d.gcDueOn ? h('p', { class: 'muted' }, `Expected latest about ${d.expectedLatestOn} if the GC billed the owner promptly.`) : null,
        pp.nonPaymentNotice?.receivedOn ? h('p', null, `Notice of non-payment received ${ui.fmtDate(pp.nonPaymentNotice.receivedOn)}: ${money(pp.nonPaymentNotice.disputedCents || 0)} disputed.`) : null) : null,
      a.checkApplies ? h('p', { class: 'muted' }, PP_CHECK_APPLIES) : null,
      a.unconfirmed ? h('p', { class: 'muted money-disclaimer' }, PP_DISCLAIMER) : null,
      h('div', { class: 'row money-actions' },
        !d.deliveredOn || a.applies ? ui.button(d.deliveredOn ? 'Change delivery' : 'When and how was this delivered?', { size: 'sm', onClick: deliverySheet }) : null,
        a.role === 'prime' && a.applies ? ui.button('Record notice of non-payment', { size: 'sm', variant: 'ghost', onClick: nonPaymentSheet }) : null,
        a.role === 'sub' && a.applies ? ui.button('The owner paid the GC', { size: 'sm', variant: 'ghost', onClick: gcPaidSheet }) : null));
  };

  const drawSide = () => {
    ui.clear(sideHost);
    const cur = store.get('invoices', id) || doc;
    const open = !['draft', 'void'].includes(cur.status);
    const disputes = cur.disputes || [];
    const reminders = store.list('outbox', (o) => o.relatedId === id && o.kind === 'invoice_reminder').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const avail = kind === 'deposit' ? R.depositsAvailable(store.list('invoices'), store.list('payments'), { jobId: cur.jobId, clientId: cur.clientId }).find((d) => d.invoiceId === id) : null;
    h(sideHost, null,
      holdbackCard(),
      promptCard(),
      kind === 'deposit' && cur.status !== 'void' ? h('div', { class: 'card', dataset: { depositCard: '1' } }, h('h3', null, `Deposit (${cur.depositModel || 'prepayment'})`),
        cur.forfeitedOn ? h('p', null, `Kept on ${ui.fmtDate(cur.forfeitedOn)}.${cur.depositModel === 'security' ? ' Ask your accountant: tax on a forfeited deposit (Excise Tax Act s.182, VERIFY).' : ''}`)
          : h('p', { class: 'muted' }, avail ? `${money(avail.availableCents)} paid and not applied yet.` : 'Not paid yet.'),
        !cur.forfeitedOn && open ? h('div', { class: 'row money-actions' }, ui.button('Refund', { size: 'sm', onClick: refundSheet }), ui.button('Keep deposit', { size: 'sm', variant: 'ghost', onClick: forfeit })) : null) : null,
      cur.status === 'draft' && !['deposit', 'credit', 'interest', 'holdback-release'].includes(kind) && !locked ? h('div', { class: 'card' }, h('h3', null, 'Deposits'),
        ui.button('Apply deposits', { size: 'sm', onClick: applyDepositsSheet })) : null,
      open && kind !== 'credit' ? h('div', { class: 'card', dataset: { disputes: '1' } }, h('h3', null, 'Disputes and adjustments'),
        disputes.length ? h('div', { class: 'list' }, disputes.map((d) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(d.cents), d.lineIndex != null ? ` · line ${d.lineIndex + 1}` : ''), h('div', { class: 'meta' }, `${d.reason || ''} · ${d.status || 'open'}`)),
          (d.status || 'open') === 'open' ? [ui.button('Concede', { size: 'sm', onClick: () => resolveDispute(d, 'conceded') }), ui.button('Won', { size: 'sm', variant: 'ghost', onClick: () => resolveDispute(d, 'won') })] : null)))
          : h('p', { class: 'muted' }, 'No disputes.'),
        h('div', { class: 'row money-actions' },
          ui.button('Record dispute', { size: 'sm', onClick: disputeSheet }),
          ui.button('Back-charge', { size: 'sm', variant: 'ghost', onClick: () => creditSheet('backcharge') }),
          ui.button('Credit note', { size: 'sm', variant: 'ghost', onClick: () => creditSheet('error') }),
          invoiceShown(store, cur).balanceCents > 0 ? ui.button('Write off as bad debt', { size: 'sm', variant: 'ghost danger', onClick: () => creditSheet('bad_debt') }) : null)) : null,
      kind === 'credit' ? h('div', { class: 'card' }, h('h3', null, 'Credit note'),
        h('p', null, `${REASON_LABEL[cur.creditReason] || 'Credit'} for ${store.get('invoices', cur.creditsInvoiceId)?.number || 'an invoice'}. ${money(-creditNoteBalance(cur, store.list('payments')))} left to apply.`),
        cur.creditReason === 'bad_debt' ? h('p', { class: 'muted' }, 'For your accountant: GST s.231 adjustment and the Manitoba RST bad-debt refund (VERIFY).') : null) : null,
      reminders.length ? h('div', { class: 'card' }, h('h3', null, 'Reminders'), h('div', { class: 'list' }, reminders.map((o) => h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, o.subject || 'Reminder'), h('div', { class: 'meta' }, `${o.channel} to ${o.to} · ${o.status}`)))))) : null);
  };

  drawStatus(); drawPayments(); drawSide();
  // Payments that arrive from the server (Stripe, another device, a QuickBooks settlement), and
  // local ones too: a payment sheet opened before this screen redrew saves through the old screen.
  const offPayments = store.on('payments', (e) => {
    if (e?.record?.invoiceId === id || e?.record?.creditNoteId === id) { refreshPaid(); drawStatus(); drawPayments(); drawSide(); }
  });
  // Prompt payment needs the rules table: refresh it in the background when online.
  if (doc.jobId && !ruleRows(store).length) {
    ctx.app?.api?.get?.(`/api/v1/rules/effective?province=${encodeURIComponent(settings.company?.province || 'MB')}`)
      .then((r) => { store.setMeta?.('rules', { ...r, fetchedAt: new Date().toISOString() }); drawSide(); }).catch(() => {});
  }

  const remove = async () => {
    // Credited or paid in QuickBooks (4.9): that payment is QuickBooks', so the invoice stays; void it.
    if (store.count('payments', (p) => p.invoiceId === id && isQuickBooksPayment(p))) {
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

  const kindLabel = { deposit: 'Deposit invoice', credit: 'Credit note', 'holdback-release': 'Invoice', interest: 'Invoice', progress: 'Invoice' }[kind] || 'Invoice';
  root.append(ui.page({
    title: doc.number,
    subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / ', clientOrJob(store, doc), kindTag(ui, doc)),
    actions: [
      // `extra` is a getter so the preview and the printout each get their own pay-link node.
      ui.button('Print / PDF', { icon: 'printer', onClick: () => { save.flush(); previewDocument({ kind: kindLabel, doc, store, paidCents: paid(), get extra() { return payLinkBlock(store, id, invoiceShown(store, { ...doc, id }).balanceCents); } }); } }),
      locked ? null : ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete invoice', onClick: remove }),
    ].filter(Boolean),
  },
  h('div', { class: 'doc-layout' },
    h('div', { class: 'stack' },
      doc.status === 'void' ? h('div', { class: 'card money-void' }, ui.badge('void', 'neutral'), ' This invoice is void and read-only.') : null,
      locked && doc.status !== 'void' ? h('div', { class: 'card money-void' }, ui.icon('lock', 16), ` Dated in a closed period (through ${locks.booksThrough}): read-only. Use "${REVERSAL_ACTION.invoices}" for a change.`) : null,
      h('div', { class: 'card' }, header),
      h('div', { class: 'card' }, h('h3', null, 'Lines'), editor),
      !['credit', 'interest', 'deposit'].includes(kind) && (doc.jobId || doc.properInvoice) ? h('div', { class: 'card' }, h('h3', null, 'Proper invoice'), proper) : null,
      h('div', { class: 'card' }, h('div', { class: 'form-grid' }, notes)),
      doc.termsText ? h('p', { class: 'muted money-terms' }, doc.termsText) : null),
    h('aside', { class: 'doc-side stack' },
      h('div', { class: 'card' }, statusHost),
      h('div', { class: 'card' }, h('h3', null, 'Totals'), totals),
      h('div', { class: 'card' }, h('h3', null, kind === 'credit' ? 'Applied' : 'Payments'), paymentsHost),
      sideHost))));

  return () => { offPayments(); save.stop(); };
}

/** Invoice fields the detail screen shows in its form: changed elsewhere, the screen is drawn again. */
const FORM_FIELDS = ['number', 'clientId', 'jobId', 'issueDate', 'dueDate', 'taxes', 'taxPct', 'taxProvince', 'taxTreatment', 'taxNoneReason', 'notes', 'lines', 'title',
  'taxExemptNumber', 'taxExemptBasis', 'taxExemptDetails', 'exemptionConfirmed', 'holdback', 'kind', 'properInvoice', 'periodFrom', 'periodTo', 'contractRef'];

// ---------- receive payment (4.4) ----------
function receiveView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  let clientId = query.clientId || '';
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
    const pick = ui.field({ label: 'Client', name: 'clientId', type: 'select', value: clientId, options: ui.recordOptions(clients, 'name', '— pick a client —') });
    pick.querySelector('select').addEventListener('change', (e) => { clientId = e.target.value; draw(); });
    host.append(h('div', { class: 'card' }, h('div', { class: 'form-grid' }, pick)));
    if (!clientId) return;
    const invoices = store.list('invoices');
    const payments = store.list('payments');
    const open = invoices.filter((i) => i.clientId === clientId && !['draft', 'void'].includes(i.status) && invoiceKind(i) !== 'credit' && R.balanceCents(i, payments) > 0)
      .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
    const form = h('div', { class: 'form-grid' },
      ui.field({ label: 'Amount received', name: 'amountCents', type: 'money', required: true }),
      ui.field({ label: 'Date', name: 'date', type: 'date', value: ui.today(), required: true }),
      ui.field({ label: 'Method', name: 'method', type: 'select', value: 'cheque', options: METHODS }),
      ui.field({ label: 'Reference', name: 'reference', placeholder: 'Cheque #, EFT reference' }));
    const inputs = new Map();
    const left = h('strong', { class: 'num' });
    const recount = () => {
      const v = ui.readForm(form);
      const used = [...inputs.values()].reduce((s, el) => s + ui.parseMoney(el.value), 0);
      left.textContent = money((v.amountCents || 0) - used);
    };
    const table = h('div', { class: 'list' }, open.map((i) => {
      const bal = R.balanceCents(i, payments);
      const c = R.collectibleCents(i, payments);
      const el = h('input', { class: 'input num', type: 'number', step: '0.01', min: '0', value: '0.00', 'aria-label': `Amount for ${i.number}`, onInput: recount });
      inputs.set(i.id, el);
      return h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, `${i.number} · due ${ui.fmtDate(i.dueDate)}`),
        h('div', { class: 'meta' }, `Balance ${money(bal)}${c !== bal ? ` · collectible ${money(c)}` : ''}`)), el);
    }));
    const suggest = () => {
      const v = ui.readForm(form);
      const a = R.allocateReceipt(v.amountCents || 0, invoices, payments, { clientId });
      for (const [iid, el] of inputs) el.value = ((a.allocations.find((x) => x.invoiceId === iid)?.amountCents || 0) / 100).toFixed(2);
      recount();
    };
    form.querySelector('[name=amountCents]').addEventListener('input', suggest);
    const save = () => {
      const v = ui.readForm(form);
      if (!(v.amountCents > 0)) { ui.toast('Enter the amount received', 'error'); return; }
      const allocs = [...inputs].map(([iid, el]) => ({ iid, cents: ui.parseMoney(el.value) })).filter((x) => x.cents > 0);
      const used = allocs.reduce((s, x) => s + x.cents, 0);
      if (used > v.amountCents) { ui.toast('The split is more than the amount received', 'error'); return; }
      const receiptId = `rc-${Date.now().toString(36)}`;
      const base = { date: v.date, method: v.method, reference: v.reference || '', receiptId, clientId };
      for (const x of allocs) { store.add('payments', { ...base, invoiceId: x.iid, amountCents: x.cents }); syncInvoiceStatus(store, x.iid); }
      if (v.amountCents - used > 0) store.add('payments', { ...base, invoiceId: null, amountCents: v.amountCents - used }, { summary: 'On account' });
      recheckHold(ctx, clientId);
      ui.toast(`${money(v.amountCents)} recorded across ${allocs.length} invoice${allocs.length === 1 ? '' : 's'}${v.amountCents - used > 0 ? `, ${money(v.amountCents - used)} on account` : ''}`, 'success', 5000);
      draw();
    };
    const credits = R.onAccountCredits(clientId, payments);
    host.append(h('div', { class: 'card stack' }, h('h3', null, 'One cheque, EFT or deposit'), form,
      open.length ? [h('p', { class: 'muted' }, 'Split across open invoices, oldest first (disputed amounts and holdback the customer kept are not expected). Edit the split; anything left goes on account.'), table]
        : h('p', { class: 'muted' }, 'No open invoices: the whole amount goes on account.'),
      h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Left for on account: '), left), h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save payment', { variant: 'primary', icon: 'dollar', onClick: save }))),
    credits.length && open.length ? h('div', { class: 'card stack', dataset: { applyCredit: '1' } }, h('h3', null, 'Apply credit'),
      h('div', { class: 'list' }, credits.map((c) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title num' }, money(c.availableCents)), h('div', { class: 'meta' }, `${ui.fmtDate(c.date)} ${c.reference}`)),
        ui.button('Apply credit', { size: 'sm', onClick: () => ui.formSheet({
          title: 'Apply on-account credit', submitLabel: 'Apply',
          fields: [
            { label: 'Invoice', name: 'invoiceId', type: 'select', value: open[0].id, options: open.map((i) => ({ value: i.id, label: `${i.number} · ${money(R.balanceCents(i, payments))}` })) },
            { label: 'Amount', name: 'cents', type: 'money', value: Math.min(c.availableCents, R.balanceCents(open[0], payments)), required: true },
          ],
          onSubmit(v) {
            const max = Math.min(c.availableCents, R.balanceCents(store.get('invoices', v.invoiceId), store.list('payments')));
            if (!(v.cents > 0) || v.cents > max) { ui.toast(`Apply between $0.01 and ${money(max)}`, 'error'); return false; }
            store.add('payments', { invoiceId: v.invoiceId, appliedFromId: c.paymentId, clientId, amountCents: v.cents, date: ui.today(), method: 'transfer', reference: 'On-account credit' });
            syncInvoiceStatus(store, v.invoiceId); recheckHold(ctx, clientId); draw();
          },
        }) }))))) : null);
  };
  root.append(ui.page({ title: 'Receive payment', subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / one payment across several invoices') }, host));
  draw();
  return store.on('payments', () => {});
}

// ---------- statements (4.5) ----------
function statementsView(root, ctx) {
  const { store, ui, query } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  let clientId = query.clientId || '';
  let from = query.from || R.plusDays(ui.today(), -90), to = query.to || ui.today();
  const host = h('div', { class: 'stack' });
  const sheetNode = (client, s) => h('div', { class: 'doc-sheet', dataset: { statement: client.id } },
    h('div', { class: 'doc-top' }, h('div', { class: 'doc-brand' }, store.settings().company?.name || ''), h('div', { class: 'doc-title' }, h('div', { class: 'doc-kind' }, 'Statement'), h('div', { class: 'doc-small' }, `${s.from} to ${s.to}`))),
    h('div', { class: 'doc-parties' }, h('div', null, h('div', { class: 'doc-label' }, 'For'), h('div', { class: 'doc-strong' }, client.name), h('div', { class: 'doc-small' }, client.address || ''))),
    h('table', { class: 'doc-lines' }, h('thead', null, h('tr', null, ['Date', 'Type', 'Number', 'Charges', 'Credits', 'Balance'].map((x, i) => h('th', { class: i > 2 ? 'right' : null }, x)))),
      h('tbody', null, h('tr', null, h('td', null, s.from), h('td', null, 'Opening balance'), h('td'), h('td'), h('td'), h('td', { class: 'right' }, money(s.openingCents))),
        s.rows.map((r) => h('tr', null, h('td', null, r.date || ''), h('td', null, r.type.replace('-', ' ')), h('td', null, r.number || ''), h('td', { class: 'right' }, r.chargeCents ? money(r.chargeCents) : ''),
          h('td', { class: 'right' }, r.creditCents ? money(r.creditCents) : ''), h('td', { class: 'right' }, money(r.balanceCents)))))),
    h('table', { class: 'doc-totals' }, h('tbody', null,
      [['Current', s.aging.current], ['1–30 days', s.aging.d30], ['31–60', s.aging.d60], ['61–90', s.aging.d90], ['Over 90', s.aging.d90p]].map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'right' }, money(v)))),
      [['Holdback you retained', s.holdbackRetainedCents], ['In dispute', s.disputedCents], ['On account', -s.onAccountCents], ['Credit notes not applied', -s.creditsCents], ['Deposits held', s.depositsUnappliedCents]]
        .filter(([, v]) => v).map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'right' }, money(v)))),
      h('tr', { class: 'grand' }, h('td', null, 'Balance'), h('td', { class: 'right' }, money(s.closingCents))))));
  const draw = () => {
    ui.clear(host);
    const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
    const form = h('div', { class: 'form-grid' },
      ui.field({ label: 'Client', name: 'clientId', type: 'select', value: clientId, options: ui.recordOptions(clients, 'name', '— pick a client —') }),
      ui.field({ label: 'From', name: 'from', type: 'date', value: from }), ui.field({ label: 'To', name: 'to', type: 'date', value: to }));
    form.addEventListener('change', () => { const v = ui.readForm(form); clientId = v.clientId; from = v.from; to = v.to; draw(); });
    host.append(h('div', { class: 'card' }, form));
    const client = clientId ? store.get('clients', clientId) : null;
    if (!client) return;
    const s = R.statement(clientId, { from, to, invoices: store.list('invoices'), payments: store.list('payments') });
    const node = sheetNode(client, s);
    host.append(h('div', { class: 'row' }, h('span', { class: 'grow' }),
      ui.button('Print', { icon: 'printer', onClick: () => printNode(sheetNode(client, s)) }),
      ui.button('Email', { icon: 'mail', variant: 'primary', onClick: async () => {
        try {
          const r = await ctx.app.api.post(`/api/v1/statements/${encodeURIComponent(clientId)}/send`, { from, to });
          ui.toast(`Statement queued to ${r.to}`, 'success');
        } catch (e) { ui.toast(e.code === 'offline' ? 'Emailing a statement needs a connection.' : e.message, 'error', 5000); }
      } })), h('div', { class: 'doc-preview' }, node));
  };
  root.append(ui.page({ title: 'Statements', subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / what a client owes, with ageing') }, host));
  draw();
  const offs = ['invoices', 'payments'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

// ---------- collections settings and interest (2.4, 4.5) ----------
function collectionsView(root, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const s = store.settings();
    const c = s.collections || {};
    const interest = c.interest || {};
    const form = h('form', { class: 'stack' },
      h('h3', null, 'Deposits'),
      ui.formGrid([
        { label: 'Default deposit kind', name: 'depModel', type: 'select', value: s.deposits?.defaultModel || 'prepayment', options: ['prepayment', 'security'] },
        { label: 'Default deposit %', name: 'depPct', type: 'number', step: '0.5', min: '0', max: '100', value: s.deposits?.defaultPct ?? '' },
      ]),
      h('h3', null, 'Terms and interest'),
      ui.formGrid([
        { label: 'Terms printed on invoices', name: 'termsText', type: 'textarea', rows: 2, span: true, value: c.termsText || '' },
        { label: 'Charge interest on overdue accounts', name: 'intOn', type: 'checkbox', value: Boolean(interest.enabled) },
        { label: 'Interest % per year', name: 'intPct', type: 'number', step: '0.1', min: '0', max: '60', value: interest.annualPct ?? '' },
        { label: 'Grace days after the due date', name: 'intGrace', type: 'number', step: '1', min: '0', value: interest.graceDays ?? 0 },
      ]),
      h('p', { class: 'muted' }, 'Interest is charged only on invoices issued with the interest sentence in their terms (Interest Act s.4: the yearly rate is always shown). Interest invoices are exempt (VERIFY with your accountant).'),
      h('h3', null, 'Holds and notices'),
      ui.formGrid([
        { label: 'Hold work when past due more than (days)', name: 'holdAfter', type: 'number', step: '1', min: '1', value: c.holdAfterDays ?? 60 },
        { label: 'Hold when over the credit limit', name: 'holdLimit', type: 'checkbox', value: c.holdOverLimit !== false },
        { label: 'Billing cutoff notice (days before)', name: 'cutoffDays', type: 'number', step: '1', min: '0', value: c.cutoffNoticeDays ?? 3 },
        { label: 'Remind to close out a complete job after (days)', name: 'closeoutDays', type: 'number', step: '1', min: '1', value: s.closeout?.remindAfterDays ?? 14 },
        { label: 'Prompt payment dates and alarms (Manitoba)', name: 'ppOn', type: 'checkbox', value: s.promptPayment?.enabled !== false },
      ]));
    const steps = (c.reminders || []).map((x) => ({ ...x }));
    const stepsHost = h('div', { class: 'stack' });
    const drawSteps = () => {
      ui.clear(stepsHost);
      stepsHost.append(steps.length ? h('div', { class: 'list' }, steps.map((st, i) => h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${st.dayOffset < 0 ? `${-st.dayOffset} days before` : `${st.dayOffset} days after`} the due date · ${st.channel}`), h('div', { class: 'meta' }, st.subject || '')),
        h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: st.active !== false, onChange: (e) => { st.active = e.target.checked; } }), h('span', null, 'On')),
        ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Remove step', onClick: () => { steps.splice(i, 1); drawSteps(); } }))))
        : h('p', { class: 'muted' }, 'Reminders are off until you add a step.'),
      h('div', { class: 'row' }, ui.button('Add the suggested steps', { size: 'sm', onClick: () => { for (const p of R.REMINDER_PRESETS) if (!steps.some((x) => x.key === p.key)) steps.push({ ...p }); drawSteps(); } }),
        ui.button('Add a step', { size: 'sm', variant: 'ghost', onClick: () => ui.formSheet({
          title: 'Reminder step', fields: [
            { label: 'Days after the due date (negative: before)', name: 'dayOffset', type: 'number', step: '1', value: 7, required: true },
            { label: 'Channel', name: 'channel', type: 'select', value: 'email', options: ['email', 'sms'] },
            { label: 'Subject', name: 'subject', span: true, value: 'Invoice {number} is overdue' },
            { label: 'Message', name: 'body', type: 'textarea', span: true, value: 'Hi {client},\n\nInvoice {number} for {balance} was due on {dueDate}.\n{payLink}\n\n{company}', hint: 'Placeholders: {client} {number} {balance} {dueDate} {payLink} {company}' },
          ],
          onSubmit(v) { steps.push({ key: `r${Date.now().toString(36)}`, ...v, dayOffset: Number(v.dayOffset) || 0, active: true }); drawSteps(); },
        }) })));
    };
    drawSteps();
    const saveAll = () => {
      const v = ui.readForm(form);
      store.saveSettings({
        deposits: { ...(s.deposits || {}), defaultModel: v.depModel, defaultPct: v.depPct == null ? null : Number(v.depPct) },
        collections: { ...c, termsText: v.termsText || '', reminders: steps, interest: { enabled: Boolean(v.intOn), annualPct: v.intPct == null ? null : Number(v.intPct), graceDays: Number(v.intGrace) || 0 },
          holdAfterDays: Number(v.holdAfter) || 60, holdOverLimit: Boolean(v.holdLimit), cutoffNoticeDays: v.cutoffDays == null ? 3 : Number(v.cutoffDays) },
        closeout: { ...(s.closeout || {}), remindAfterDays: Number(v.closeoutDays) || 14 },
        promptPayment: { ...(s.promptPayment || {}), enabled: Boolean(v.ppOn) },
      });
      ui.toast('Collections settings saved', 'success');
    };
    // "Charge interest" (monthly): one interest invoice per client, never the same period twice.
    const charge = () => {
      const st = store.settings();
      const ic = st.collections?.interest || {};
      if (!ic.enabled || !(Number(ic.annualPct) > 0)) { ui.toast('Turn interest on and set the rate first', 'error'); return; }
      const invoices = store.list('invoices'), payments = store.list('payments');
      const byClient = new Map();
      for (const ch of R.interestCharges(invoices, payments, { annualPct: ic.annualPct, graceDays: ic.graceDays, asOf: ui.today() })) {
        const cid = store.get('invoices', ch.invoiceId)?.clientId;
        if (!cid) continue;
        if (!byClient.has(cid)) byClient.set(cid, []);
        byClient.get(cid).push(ch);
      }
      if (!byClient.size) { ui.toast('No interest to charge today', 'info'); return; }
      let n = 0;
      for (const [cid, list] of byClient) { store.add('invoices', { ...R.interestInvoice(cid, list, { today: ui.today() }), number: store.nextNumber('invoice') }); n++; }
      ui.toast(`${n} interest invoice${n === 1 ? '' : 's'} drafted. Check and send them.`, 'success', 5000);
    };
    host.append(h('div', { class: 'card' }, form), h('div', { class: 'card stack' }, h('h3', null, 'Reminder steps'), h('p', { class: 'muted' }, 'Sent from your company email or texts (Pro and Business). The amount is what is owed less disputes and holdback the customer kept. Texts honour STOP.'), stepsHost),
      h('div', { class: 'row' }, ui.button('Charge interest now', { onClick: charge }), h('span', { class: 'grow' }), ui.button('Save', { variant: 'primary', onClick: saveAll })),
      h('p', { class: 'muted' }, `Unbilled interest today: ${money(R.interestCharges(store.list('invoices'), store.list('payments'), { annualPct: interest.annualPct, graceDays: interest.graceDays, asOf: ui.today() }).reduce((t, x) => t + x.cents, 0))}.`));
  };
  root.append(ui.page({ title: 'Collections', subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / deposits, interest, reminders and holds') }, host));
  draw();
  return store.on('settings', () => {});
}

// ---------- ready to bill (4.7) ----------
function readyView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const src = { ...sources(store), dayOf: ui.localDay };
    const rows = R.readyToBill(src, { asOf: ui.today() });
    const lag = R.invoiceLagDays({ jobs: src.jobs, fieldTickets: src.fieldTickets, invoices: src.invoices, asOf: ui.today() });
    const d = R.dso({ invoices: src.invoices, payments: src.payments, asOf: ui.today() });
    host.append(h('div', { class: 'grid money-stats' },
      ui.stat({ label: 'Ready to bill', value: String(rows.length), hint: rows.length ? `oldest ${rows[0].ageDays} days` : 'nothing waiting', tone: rows.length ? 'accent' : null }),
      ui.stat({ label: 'Invoice lag', value: lag.medianDays == null ? '—' : `${lag.medianDays} days`, hint: `median, ${lag.count} in the last 90 days` }),
      ui.stat({ label: 'Days sales outstanding', value: d.days == null ? '—' : `${d.days} days`, hint: 'last 90 days' })),
    ui.table({
      columns: [
        { key: 'age', label: 'Age', align: 'right', render: (r) => `${r.ageDays} d`, sort: (r) => r.ageDays },
        { key: 'what', label: 'What', render: (r) => r.label, sort: (r) => r.label },
        { key: 'kind', label: 'Kind', render: (r) => ui.badge(r.kind.replace('-', ' '), r.kind === 'dispute' ? 'warning' : 'neutral'), sort: (r) => r.kind },
        { key: 'go', label: '', render: (r) => ui.button('Open', { size: 'sm', href: r.href }) },
      ],
      rows, onRowClick: (r) => nav(r.href),
      empty: ui.empty({ icon: 'check', title: 'Nothing waiting to bill', text: 'Signed tickets, approved change orders, unbilled T&M, finished jobs and holdback due show up here.' }),
    }));
  };
  root.append(ui.page({ title: 'Ready to bill', subtitle: h('span', null, h('a', { href: '#/invoices' }, 'Invoices'), ' / what can be invoiced now, oldest first') }, host));
  draw();
  const offs = ['invoices', 'jobs', 'fieldTickets', 'timeEntries'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

