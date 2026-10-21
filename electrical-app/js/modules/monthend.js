// Month-end (#/monthend): the cutoff export for the accountant (docs/releases/r1-get-paid.md 8.3,
// docs/office/month-end.md). Computed on this device with lib/month-end.js: revenue accruals from WIP
// and unbilled T&M, received-not-billed, accrued payroll, holdback, deposits, on-account credit,
// disputes, self-assessed RST, bad-debt credit notes, inventory by location as of the cutoff, and a
// suggested journal with named accounts (reverse it on the 1st). Prints and exports CSV; nothing is
// pushed to QuickBooks. Office money roles only; Pro plan (the app hides the module otherwise).
import { cutoff, cutoffCsv } from '../lib/month-end.js';
import { endOfLastMonth, dayIn, zoneFor } from '../lib/closing.js';
import { costSources, ensureStyles } from './reports.js';

export default {
  id: 'monthend',
  title: 'Month-end',
  icon: 'calendar',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    ensureStyles();
    const { ui, store, auth } = ctx;
    const { h } = ui;
    const host = h('div', { class: 'reports' });
    root.append(host);
    if (!auth.seesMoney?.()) {
      host.append(ui.page({ title: 'Month-end' }, ui.empty({ icon: 'lock', title: 'Month-end is for the office' })));
      return;
    }
    const today = dayIn(new Date().toISOString(), zoneFor(store.settings()?.company?.province));
    let asOf = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.asOf || '') ? ctx.query.asOf : endOfLastMonth(today);
    const draw = () => {
      const c = cutoff({ ...costSources(store, ui), asOf });
      const m = (x) => ui.fmtMoney(x);
      const csvMoney = (x) => ui.centsToInput(x);
      const date = h('input', { type: 'date', name: 'asOf', value: asOf });
      date.addEventListener('change', () => { if (date.value) { asOf = date.value; draw(); } });
      const rows = (list) => h('div', { class: 'me-rows' }, list.map(([label, value]) => h('div', { class: 'me-row' }, h('span', null, label), h('span', { class: 'num' }, value))));
      const total = (label, value) => h('div', { class: 'me-total' }, h('span', null, label), h('span', { class: 'num' }, value));
      const block = (title, ...children) => h('section', { class: 'card me-block' }, h('h3', null, title), ...children);
      const detail = (summary, node) => h('details', null, h('summary', null, summary), node);
      const ar = c.accruedRevenue;
      ui.clear(host).append(ui.page({ title: 'Month-end', subtitle: 'What the accountant needs to close the month, as of the cutoff' },
        h('div', { class: 'row rep-range' },
          h('label', { class: 'field' }, h('span', null, 'Cutoff'), date), h('span', { class: 'grow' }),
          ui.button('Export CSV', { icon: 'download', onClick: () => { ui.download(`month-end-${asOf}.csv`, cutoffCsv(c, { money: csvMoney }), 'text/csv'); store.log('export', `Month-end cutoff ${asOf} exported`, 'settings'); } }),
          ui.button('Print', { icon: 'printer', variant: 'ghost', onClick: () => window.print() })),
        h('p', { class: 'muted rep-small' }, 'A suggestion for your accountant: enter the journal as of the cutoff and reverse it on the 1st. Close the books on Books → Closing date once it is done. Nothing here goes to QuickBooks.'),
        h('div', { class: 'me-blocks' },
          block('Revenue not billed yet',
            rows([['Under billed (fixed price, WIP)', m(ar.wipUnderBilledCents)], ['Over billed (fixed price, WIP)', m(ar.wipOverBilledCents)], ['T&M not billed yet', m(ar.tmUnbilledCents)]]),
            ar.rows.length ? detail(`${ar.rows.length} job${ar.rows.length === 1 ? '' : 's'}`, rows(ar.rows.map((x) => [`${x.number} ${x.title}`, x.underBilledCents ? `${m(x.underBilledCents)} under` : `${m(x.overBilledCents)} over`]))) : null,
            c.changeOrdersApprovedUnbilled.length ? detail(`${c.changeOrdersApprovedUnbilled.length} approved change order${c.changeOrdersApprovedUnbilled.length === 1 ? '' : 's'} not billed (already in WIP's contract)`,
              rows(c.changeOrdersApprovedUnbilled.map((x) => [`${x.number} ${x.title}`, m(x.amountCents)]))) : null),
          block('Received, not billed',
            total('At the purchase-order price', m(c.accruedCost.receivedNotBilledCents)),
            c.accruedCost.rows.length ? detail(`${c.accruedCost.rows.length} order line${c.accruedCost.rows.length === 1 ? '' : 's'}`, rows(c.accruedCost.rows.map((x) => [`${x.number} line ${x.index + 1}: ${x.description}`, m(x.cents)]))) : null),
          block('Payroll not paid yet',
            rows([['Wages', m(c.accruedPayroll.wagesCents)], ['Burden (CPP, EI, WCB…)', m(c.accruedPayroll.burdenCents)],
              ['Vacation pay', c.accruedPayroll.vacationCents ? m(c.accruedPayroll.vacationCents) : 'paid on each cheque'], ['Holiday pay', c.accruedPayroll.holidayCents ? m(c.accruedPayroll.holidayCents) : 'paid on each cheque']]),
            h('p', { class: 'muted rep-small' }, 'Hours worked on or before the cutoff that are in no exported payroll run.'),
            c.accruedPayroll.rows.length ? detail('By employee', rows(c.accruedPayroll.rows.map((x) => [`${x.name || 'Someone'} (${ui.fmtNum(x.minutes / 60, 2)} h)`, m(x.wagesCents + x.burdenCents)]))) : null),
          block('Balances',
            rows([['Holdback receivable', m(c.holdbackReceivableCents)], ['Customer deposits not applied', m(c.depositsUnappliedCents)], ['On-account credit', m(c.onAccountCreditCents)],
              ['Disputed', m(c.disputedCents)], ['RST to self-assess this month', m(c.rstSelfAssessCents)]]),
            c.badDebtCreditNotes.length ? detail(`${c.badDebtCreditNotes.length} bad-debt credit note${c.badDebtCreditNotes.length === 1 ? '' : 's'} (GST and RST relief: ask the accountant)`,
              rows(c.badDebtCreditNotes.map((x) => [`${x.number} ${ui.fmtDate(x.issueDate)}`, m(x.totalCents)]))) : null,
            c.signedTicketsUnpriced ? h('p', { class: 'rep-small' }, `${c.signedTicketsUnpriced} signed or refused field ticket${c.signedTicketsUnpriced === 1 ? '' : 's'} not priced or billed yet.`) : null),
          block('Inventory by location',
            rows(c.inventory.map((x) => [x.name, m(x.valueCents)])),
            total('Total', m(c.inventory.reduce((s, x) => s + x.valueCents, 0))),
            h('p', { class: 'muted rep-small' }, 'Quantity there on the cutoff at the moving average then (Inventory → Valuation).'))),
        h('h2', { class: 'section' }, 'Journal (suggested; reverse on the 1st)'),
        ui.table({
          columns: [
            { key: 'account', label: 'Account' },
            { key: 'dr', label: 'Debit', align: 'right', render: (j) => (j.debitCents ? m(j.debitCents) : '') },
            { key: 'cr', label: 'Credit', align: 'right', render: (j) => (j.creditCents ? m(j.creditCents) : '') },
            { key: 'memo', label: 'Memo', render: (j) => h('span', { class: 'rep-small' }, j.memo) },
          ],
          rows: c.journal,
          empty: ui.empty({ icon: 'check', title: 'Nothing to accrue', text: 'No accruals at this cutoff.' }),
        })));
    };
    draw();
    let pending = null;
    const later = () => { clearTimeout(pending); pending = setTimeout(draw, 150); };
    const offs = ['jobs', 'invoices', 'payments', 'timeEntries', 'payrollRuns', 'bills', 'purchaseOrders', 'stockMoves', 'items', 'settings'].map((coll) => store.on(coll, later));
    return () => { offs.forEach((f) => f()); clearTimeout(pending); };
  },
};
