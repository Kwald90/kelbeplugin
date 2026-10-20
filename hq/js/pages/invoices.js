// Invoicing: Fishtape's subscription invoices, live from Stripe, by company, status and date.
// Open the hosted invoice, resend it, and (HQ admins) mark it uncollectible, issue a credit
// note or refund, each with a confirm dialog showing the amount and the reason. Audited.
import { get, post } from '../api.js';
import { labelled, loader, requestKey } from '../kit.js';

const STATUSES = ['', 'open', 'paid', 'uncollectible', 'void', 'draft'];
const TONE = { open: 'warning', paid: 'success', uncollectible: 'danger', void: 'neutral', draft: 'neutral' };
const CREDIT_REASONS = [
  { value: '', label: 'Not given' }, { value: 'order_change', label: 'Order change' }, { value: 'product_unsatisfactory', label: 'Product unsatisfactory' },
  { value: 'duplicate', label: 'Duplicate' }, { value: 'fraudulent', label: 'Fraudulent' },
];

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    const q = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
    const company = h('select', { 'aria-label': 'Company' }, h('option', { value: '' }, 'All companies'));
    const status = h('select', { 'aria-label': 'Status' }, STATUSES.map((s) => h('option', { value: s, selected: s === (q.status || '') }, s ? s : 'Any status')));
    const from = h('input', { type: 'date', 'aria-label': 'From' });
    const to = h('input', { type: 'date', 'aria-label': 'To' });
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Invoices', subtitle: 'Fishtape subscription invoices from Stripe' },
      h('form', { class: 'hq-toolbar hq-filters', onSubmit: (e) => { e.preventDefault(); load(); } },
        labelled(ui, 'Company', company), labelled(ui, 'Status', status), labelled(ui, 'From', from), labelled(ui, 'To', to),
        ui.button('Show', { variant: 'primary', type: 'submit', icon: 'search' })),
      body));

    get('/api/hq/tenants').then((r) => {
      for (const t of r.data.sort((a, b) => a.name.localeCompare(b.name))) company.append(h('option', { value: t.id, selected: t.id === q.company }, t.name));
      if (q.company) load();
    }).catch(() => { /* filter by company unavailable */ });

    let rows = [];
    function load() {
      const p = new URLSearchParams();
      if (company.value) p.set('tenantId', company.value);
      if (status.value) p.set('status', status.value);
      if (from.value) p.set('from', from.value);
      if (to.value) p.set('to', to.value);
      return loader(ui, body, async () => {
        const r = await get(`/api/hq/invoices?${p}`);
        rows = r.data;
        draw(r);
      });
    }

    function draw(r) {
      ui.clear(body);
      body.append(ui.table({
        columns: [
          { key: 'created', label: 'Date', render: (i) => ui.fmtDate(i.createdAt), sort: (i) => i.createdAt },
          { key: 'number', label: 'Invoice', render: (i) => h('div', null, h('span', { class: 'mono hq-small' }, i.number || i.id), i.deposit ? h('div', { class: 'muted hq-small' }, 'sign-up deposit') : null) },
          { key: 'co', label: 'Company', render: (i) => (i.tenantId ? h('a', { href: `#/tenants/${i.tenantId}`, onClick: (e) => e.stopPropagation() }, i.tenantName) : '—'), sort: (i) => i.tenantName || '' },
          { key: 'status', label: 'Status', render: (i) => h('div', null, ui.badge(i.status, TONE[i.status] || 'neutral'), i.attempts && i.status === 'open' ? h('div', { class: 'muted hq-small' }, `${i.attempts} failed attempt${i.attempts === 1 ? '' : 's'}`) : null), sort: (i) => i.status },
          { key: 'total', label: 'Total', align: 'right', render: (i) => ui.fmtMoney(i.totalCents), sort: (i) => i.totalCents },
          { key: 'due', label: 'Owing', align: 'right', render: (i) => (i.amountRemainingCents ? ui.fmtMoney(i.amountRemainingCents) : '—') },
          { key: 'credited', label: 'Credited', align: 'right', render: (i) => (i.creditedCents ? ui.fmtMoney(i.creditedCents) : '—') },
        ],
        rows,
        onRowClick: open,
        empty: ui.empty({ icon: 'receipt', title: 'No invoices match', text: company.value ? 'This company has no Stripe invoices with these filters.' : 'Only invoices of Fishtape companies are listed; other invoices on the account are left out.' }),
      }));
      if (!company.value) body.append(h('p', { class: 'muted hq-small' }, `Looked at the ${r.scanned} newest invoices on the Stripe account. Pick a company to see all of theirs.`));
    }

    function open(i) {
      const acts = [];
      if (i.hostedInvoiceUrl) acts.push(ui.button('Open invoice', { icon: 'eye', href: i.hostedInvoiceUrl }));
      if (i.pdfUrl) acts.push(ui.button('PDF', { icon: 'download', href: i.pdfUrl }));
      if (['open', 'paid'].includes(i.status)) acts.push(ui.button('Resend', { icon: 'send', onClick: () => resend(i) }));
      if (isAdmin && i.status === 'open') acts.push(ui.button('Mark uncollectible', { variant: 'danger', onClick: () => uncollectible(i) }));
      if (isAdmin && ['open', 'paid'].includes(i.status)) acts.push(ui.button('Credit note…', { onClick: () => money(i, 'credit') }));
      if (isAdmin && i.status === 'paid') acts.push(ui.button('Refund…', { variant: 'danger', onClick: () => money(i, 'refund') }));
      for (const a of acts) if (a.tagName === 'A') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      const s = ui.openSheet({
        title: `Invoice ${i.number || i.id}`,
        body: h('div', { class: 'stack' },
          h('dl', { class: 'hq-kv' },
            h('dt', null, 'Company'), h('dd', null, i.tenantName || '—'),
            h('dt', null, 'Status'), h('dd', null, ui.badge(i.status, TONE[i.status] || 'neutral')),
            h('dt', null, 'Created'), h('dd', null, ui.fmtDateTime(i.createdAt)),
            h('dt', null, 'Paid'), h('dd', null, i.paidAt ? ui.fmtDateTime(i.paidAt) : '—'),
            h('dt', null, 'Total'), h('dd', null, ui.fmtMoney(i.totalCents)),
            h('dt', null, 'Paid amount'), h('dd', null, ui.fmtMoney(i.amountPaidCents)),
            h('dt', null, 'Owing'), h('dd', null, ui.fmtMoney(i.amountRemainingCents)),
            h('dt', null, 'GST/HST'), h('dd', null, i.taxCents == null ? 'no tax data' : ui.fmtMoney(i.taxCents)),
            h('dt', null, 'Credited'), h('dd', null, ui.fmtMoney(i.creditedCents)),
            h('dt', null, 'Why'), h('dd', null, (i.billingReason || '—').replace(/_/g, ' ')),
            h('dt', null, 'Stripe id'), h('dd', { class: 'mono hq-small' }, i.id)),
          h('div', { class: 'hq-pill-list' }, acts),
          isAdmin ? null : h('p', { class: 'muted hq-small' }, 'HQ admins issue credit notes and refunds and mark invoices uncollectible.')),
      });
      i.closeSheet = () => s.close();
    }

    async function resend(i) {
      if (!(await ui.confirmDialog(`Stripe emails invoice ${i.number || i.id} to ${i.tenantName} again.`, { title: 'Resend the invoice?', okLabel: 'Resend', danger: false }))) return;
      try { await post(`/api/hq/invoices/${i.id}/resend`); ui.toast('Invoice sent again', 'success'); } catch (e) { ui.toast(e.message, 'error'); }
    }

    async function uncollectible(i) {
      const reason = await ui.promptDialog('Why will this not be paid? (kept in the audit log)', { title: `Mark ${i.number || i.id} uncollectible`, okLabel: 'Continue' });
      if (reason == null) return;
      if (reason.trim().length < 5) { ui.toast('Give a reason of at least 5 characters', 'error'); return; }
      if (!(await ui.confirmDialog(`${ui.fmtMoney(i.amountRemainingCents)} owed by ${i.tenantName} will be written off. Reason: ${reason.trim()}`, { title: 'Mark uncollectible?', okLabel: 'Mark uncollectible' }))) return;
      try { await post(`/api/hq/invoices/${i.id}/uncollectible`, { reason: reason.trim() }); ui.toast('Marked uncollectible', 'success'); i.closeSheet?.(); load(); } catch (e) { ui.toast(e.message, 'error'); }
    }

    function money(i, kind) {
      const refund = kind === 'refund';
      const max = refund ? i.amountPaidCents : (i.status === 'open' ? i.amountRemainingCents : i.amountPaidCents - i.creditedCents);
      const key = requestKey();
      ui.formSheet({
        title: refund ? `Refund invoice ${i.number || i.id}` : `Credit note on ${i.number || i.id}`,
        extra: h('p', { class: 'muted hq-small', style: { margin: 0 } }, refund
          ? `Goes back to ${i.tenantName}'s card. At most ${ui.fmtMoney(max)} minus anything already refunded.`
          : i.status === 'open' ? `Lowers what ${i.tenantName} owes on this invoice (at most ${ui.fmtMoney(max)}).` : `Paid invoice: the credit goes on ${i.tenantName}'s Stripe balance and comes off their next invoice (at most ${ui.fmtMoney(max)}).`),
        fields: [
          { label: 'Amount (CAD)', name: 'amount', type: 'money', required: true, value: max },
          { label: 'Reason (kept in the audit log, the company sees it)', name: 'reason', type: 'textarea', required: true, span: true },
          refund ? null : { label: 'Stripe reason', name: 'stripeReason', type: 'select', options: CREDIT_REASONS },
        ].filter(Boolean),
        submitLabel: 'Review',
        onSubmit: (v) => {
          if (!(v.amount > 0)) { ui.toast('Enter an amount', 'error'); return false; }
          if (v.amount > max) { ui.toast(`At most ${ui.fmtMoney(max)}`, 'error'); return false; }
          if (v.reason.trim().length < 5) { ui.toast('Give a reason of at least 5 characters', 'error'); return false; }
          confirmMoney(i, kind, { amountCents: v.amount, reason: v.reason.trim(), stripeReason: v.stripeReason || undefined, requestKey: key });
        },
      });
    }

    async function confirmMoney(i, kind, body) {
      const refund = kind === 'refund';
      const ok = await ui.confirmDialog(`${refund ? 'Refund' : 'Credit'} ${ui.fmtMoney(body.amountCents)} to ${i.tenantName} on invoice ${i.number || i.id}. Reason: "${body.reason}". This goes to Stripe straight away and cannot be undone here.`,
        { title: refund ? 'Send the refund?' : 'Issue the credit note?', okLabel: refund ? `Refund ${ui.fmtMoney(body.amountCents)}` : `Credit ${ui.fmtMoney(body.amountCents)}` });
      if (!ok) return;
      try {
        await post(`/api/hq/invoices/${i.id}/${refund ? 'refund' : 'credit-note'}`, body);
        ui.toast(refund ? 'Refund sent' : 'Credit note issued', 'success');
        i.closeSheet?.();
        load();
      } catch (e) { ui.toast(e.message, 'error', 6000); }
    }

    if (!q.company) load();
    return () => {};
  },
};
