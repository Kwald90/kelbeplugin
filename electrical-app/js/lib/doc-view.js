// Shared pieces for estimates and invoices: line editor, tax editor, totals
// panel, price-book picker and the printable document.
import { h, clear, icon, button, parseMoney, centsToInput, fmtDate, fmtNum, openSheet, searchBox, toast, badge, field } from '../ui.js';
import { docTotals, lineCents, moneyFormatter, combinedPct, KINDS } from './money.js';
import { PROVINCES, TREATMENTS, treatmentsFor, treatmentHint, taxComponents, taxSetup, newDocTax, describeTaxes, fmtPct, provinceName } from './tax.js';

/**
 * lineEditor({ doc, store, onChange, labourRateCents }) -> element
 * Mutates doc.lines in place and calls onChange() after every edit.
 */
export function lineEditor({ doc, store, onChange, readOnly = false }) {
  doc.lines = doc.lines || [];
  const money = moneyFormatter(store.settings());
  const wrap = h('div', { class: 'lines' });
  const body = h('div', { class: 'lines-body' });

  const draw = () => {
    clear(body);
    if (!doc.lines.length) {
      body.append(h('div', { class: 'lines-empty muted' }, 'No lines yet. Add items from the price book, a custom line, or labour.'));
    }
    doc.lines.forEach((l, i) => body.append(row(l, i)));
  };

  const changed = (redraw) => { if (redraw) draw(); onChange?.(); };

  function row(l, i) {
    const amount = h('div', { class: 'line-amount num' }, money(lineCents(l)));
    const refreshAmount = () => { amount.textContent = money(lineCents(l)); };
    const desc = h('input', { class: 'input', value: l.description || '', 'aria-label': `Line ${i + 1} description`, placeholder: 'Description', readonly: readOnly,
      onInput: (e) => { l.description = e.target.value; changed(); } });
    const qty = h('input', { class: 'input num', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.qty ?? 1, 'aria-label': `Line ${i + 1} quantity`, readonly: readOnly,
      onInput: (e) => { l.qty = e.target.value === '' ? 0 : Number(e.target.value); refreshAmount(); changed(); } });
    const unit = h('input', { class: 'input num', type: 'number', step: '0.01', inputmode: 'decimal', value: centsToInput(l.unitCents), 'aria-label': `Line ${i + 1} unit price`, readonly: readOnly,
      onInput: (e) => { l.unitCents = parseMoney(e.target.value); refreshAmount(); changed(); } });
    // The kind decides how each tax applies to the line (see tax.js treatments).
    const kind = h('select', { class: 'line-kind', 'aria-label': `Line ${i + 1} type (sets how tax applies)`, title: 'Type: sets how tax applies to this line', disabled: readOnly,
      onChange: (e) => { l.kind = e.target.value; changed(); } },
      KINDS.map((k) => h('option', { value: k, selected: (l.kind || 'material') === k }, k)));
    const hrs = Number(l.labourHours) || 0;
    const meta = h('div', { class: 'line-meta' }, kind,
      hrs && l.kind !== 'labour' ? h('span', { class: 'muted' }, `${fmtNum(hrs, 2)} h/unit crew time`) : null,
      l.itemId ? h('span', { class: 'muted' }, 'price book') : null);
    const actions = readOnly ? h('div') : h('div', { class: 'line-actions' },
      button('', { variant: 'ghost', size: 'sm', icon: '<path d="M12 19V5M5 12l7-7 7 7"/>', title: 'Move up', disabled: i === 0,
        onClick: () => { [doc.lines[i - 1], doc.lines[i]] = [doc.lines[i], doc.lines[i - 1]]; changed(true); } }),
      button('', { variant: 'ghost', size: 'sm', icon: '<path d="M12 5v14M5 12l7 7 7-7"/>', title: 'Move down', disabled: i === doc.lines.length - 1,
        onClick: () => { [doc.lines[i + 1], doc.lines[i]] = [doc.lines[i], doc.lines[i + 1]]; changed(true); } }),
      button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Delete line',
        onClick: () => { doc.lines.splice(i, 1); changed(true); } }));
    return h('div', { class: 'line-row' },
      h('div', { class: 'line-desc' }, desc, meta),
      h('label', { class: 'line-qty' }, h('span', { class: 'line-label' }, 'Qty'), qty),
      h('label', { class: 'line-unit' }, h('span', { class: 'line-label' }, 'Unit'), unit),
      h('div', { class: 'line-amt' }, h('span', { class: 'line-label' }, 'Amount'), amount),
      actions);
  }

  const head = h('div', { class: 'line-row line-head' },
    h('div', null, 'Description'), h('div', null, 'Qty'), h('div', null, 'Unit price'), h('div', { class: 'right' }, 'Amount'), h('div'));

  const addBar = readOnly ? null : h('div', { class: 'row lines-add' },
    button('Price book', { icon: 'box', size: 'sm', onClick: () => pickItems(store, (it) => {
      doc.lines.push({ itemId: it.id, description: it.name, qty: 1, unitCents: it.priceCents, labourHours: it.labourHours || 0, kind: 'material' });
      changed(true);
    }) }),
    button('Custom line', { icon: 'plus', size: 'sm', onClick: () => {
      doc.lines.push({ itemId: null, description: '', qty: 1, unitCents: 0, labourHours: 0, kind: 'other' });
      changed(true);
      body.querySelector('.line-row:last-child .line-desc input')?.focus();
    } }),
    button('Labour', { icon: 'clock', size: 'sm', onClick: () => {
      const rate = doc.labourRateCents ?? store.settings().labourRateCents;
      doc.lines.push({ itemId: null, description: 'Labour', qty: 1, unitCents: rate, labourHours: 1, kind: 'labour' });
      changed(true);
    } }));

  wrap.append(head, body, addBar || '');
  draw();
  wrap.redraw = draw;
  return wrap;
}

/** Tax fields for a document: [province field, treatment field, summary]. Sets doc.taxes etc. */
export function taxEditor({ doc, store, onChange, readOnly = false, dateKey = null }) {
  const s = store.settings();
  const setup = taxSetup(s);
  const legacy = !Array.isArray(doc.taxes);
  const hasCustom = setup.custom.length > 0;
  const summary = h('div', { class: 'field span-2' });

  const apply = (province, treatment) => {
    if (treatment === 'custom') {
      Object.assign(doc, newDocTax({ ...s, tax: { ...setup, mode: 'custom' } }));
    } else {
      const date = (dateKey && doc[dateKey]) || new Date();
      doc.taxes = taxComponents({ province, treatment, date });
      doc.taxProvince = province;
      doc.taxTreatment = treatment;
      doc.taxPct = combinedPct(doc.taxes.filter((t) => t.applies.material || t.applies.labour || t.applies.other));
    }
  };

  const provinceSel = field({ label: 'Tax province', name: 'taxProvince', type: 'select', value: doc.taxProvince || (legacy ? '' : setup.province),
    options: [legacy ? { value: '', label: '—' } : null, ...PROVINCES.map((p) => ({ value: p.code, label: p.name }))].filter(Boolean),
    hint: 'Where the work is done' });
  const treatmentHost = h('div', { style: { display: 'contents' } });
  let treatmentSel;
  const drawTreatment = () => {
    clear(treatmentHost);
    const prov = doc.taxProvince || setup.province;
    const opts = [
      legacy ? { value: 'legacy', label: `Old single rate ${fmtPct(doc.taxPct)}% (all lines)` } : null,
      ...treatmentsFor(prov).map((id) => ({ value: id, label: TREATMENTS[id].label })),
      hasCustom ? { value: 'custom', label: 'Company custom rates' } : null,
    ].filter(Boolean);
    treatmentSel = field({ label: 'Tax treatment', name: 'taxTreatment', type: 'select', value: legacy ? 'legacy' : doc.taxTreatment, options: opts });
    treatmentSel.querySelector('select').disabled = readOnly;
    treatmentSel.querySelector('select').addEventListener('change', (e) => {
      if (e.target.value === 'legacy') return;
      apply(doc.taxProvince || setup.province, e.target.value);
      drawSummary(); onChange?.();
    });
    treatmentHost.append(treatmentSel);
  };
  const drawSummary = () => {
    clear(summary);
    const hint = treatmentHint(doc.taxTreatment, doc.taxProvince);
    const pst = (doc.taxes || []).some((x) => ['PST', 'RST'].includes(x.id));
    h(summary, null,
      h('span', null, h('strong', null, describeTaxes(docTaxesOf(doc))), doc.taxProvince ? ` · ${provinceName(doc.taxProvince)}` : ''),
      hint ? h('span', { class: 'hint' }, hint) : null,
      pst ? h('span', { class: 'hint' }, icon('info', 14), ' PST/RST on contracting work depends on the job and the customer. Check with your accountant.') : null);
  };
  provinceSel.querySelector('select').disabled = readOnly;
  provinceSel.querySelector('select').addEventListener('change', (e) => {
    const prov = e.target.value;
    if (!prov) return;
    const keep = treatmentsFor(prov).includes(doc.taxTreatment) ? doc.taxTreatment : treatmentsFor(prov)[0];
    apply(prov, keep);
    drawTreatment(); drawSummary(); onChange?.();
  });
  drawTreatment(); drawSummary();
  const nodes = [provinceSel, treatmentHost, summary];
  /** Re-rate after the document date changes (rates are dated, e.g. NS HST on 2025-04-01). */
  nodes.recompute = () => {
    if (Array.isArray(doc.taxes) && doc.taxProvince && TREATMENTS[doc.taxTreatment]) { apply(doc.taxProvince, doc.taxTreatment); drawSummary(); }
  };
  return nodes;
}

const docTaxesOf = (doc) => (Array.isArray(doc.taxes) ? doc.taxes : (Number(doc.taxPct) ? [{ label: 'Tax', pct: doc.taxPct }] : []));

/** Label for a tax row: "GST 5%", plus "on $1,200.00" when it doesn't apply to the whole subtotal. */
function taxLabel(t, subtotalCents, money) {
  return `${t.label} ${fmtPct(t.pct)}%${t.baseCents !== subtotalCents ? ` on ${money(t.baseCents)}` : ''}`;
}

/** Totals card that can be refreshed in place: el.update(doc). */
export function totalsPanel(doc, { showMarkup = true, paidCents = null, money = moneyFormatter(null) } = {}) {
  const el = h('div', { class: 'totals' });
  el.update = (d) => {
    const t = docTotals(d);
    const paid = typeof paidCents === 'function' ? paidCents() : paidCents;
    clear(el);
    const row = (label, v, cls) => h('div', { class: ['totals-row', cls] }, h('span', null, label), h('span', { class: 'num' }, v));
    const charged = t.taxes.filter((x) => x.baseCents > 0 || x.cents);
    h(el, null,
      row('Materials', money(t.materialCents)),
      row('Labour', money(t.labourCents)),
      row('Other', money(t.otherCents)),
      showMarkup && t.markupCents ? row(`Markup (${fmtNum(d.markupPct, 1)}%)`, money(t.markupCents)) : null,
      row('Subtotal', money(t.subtotalCents), 'strong'),
      charged.length ? charged.map((x) => row(taxLabel(x, t.subtotalCents, money), money(x.cents))) : row('Tax', money(0)),
      row('Total', money(t.totalCents), 'grand'),
      paid != null ? row('Paid', money(paid)) : null,
      paid != null ? row('Balance due', money(t.totalCents - paid), 'grand') : null,
      t.taxes.filter((x) => x.note && !x.baseCents).map((x) => h('div', { class: 'totals-hint muted' }, x.note)),
      h('div', { class: 'totals-hint muted' }, `Crew time: ${fmtNum(t.hours, 1)} h`));
  };
  el.update(doc);
  return el;
}

/** Searchable price-book picker. onPick(item) is called per click; the sheet stays open. */
export function pickItems(store, onPick) {
  const money = moneyFormatter(store.settings());
  const items = store.list('items').sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  let q = '';
  const list = h('div', { class: 'list picker-list' });
  const draw = () => {
    clear(list);
    const needle = q.trim().toLowerCase();
    const rows = items.filter((i) => !needle || [i.name, i.sku, i.category].some((s) => (s || '').toLowerCase().includes(needle)));
    if (!rows.length) list.append(h('div', { class: 'list-row muted' }, 'No matching items.'));
    for (const it of rows.slice(0, 200)) {
      list.append(h('button', { type: 'button', class: 'list-row click picker-row', onClick: () => { onPick(it); toast(`Added ${it.name}`, 'success', 1400); } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, it.name), h('div', { class: 'meta' }, [it.sku, it.category, it.unit].filter(Boolean).join(' · '))),
        h('span', { class: 'num' }, money(it.priceCents)), icon('plus', 16)));
    }
  };
  const s = openSheet({
    title: 'Add from price book',
    body: h('div', { class: 'stack' }, searchBox('Search name, SKU or category', (v) => { q = v; draw(); }), list),
    actions: [button('Done', { variant: 'primary', onClick: () => s.close() })],
  });
  draw();
  return s;
}

/** Build the printable document node. */
export function documentNode({ kind, doc, store, paidCents = null, extra }) {
  const s = store.settings();
  const money = moneyFormatter(s);
  const co = s.company || {};
  const client = doc.clientId ? store.get('clients', doc.clientId) : null;
  const job = doc.jobId ? store.get('jobs', doc.jobId) : null;
  const t = docTotals(doc);
  const tr = (label, v, cls) => h('tr', { class: cls }, h('td', null, label), h('td', { class: 'right num' }, v));
  // CRA: an invoice must show the supplier's GST/HST registration number for the
  // customer to claim input tax credits. PST numbers are shown when set.
  const regs = [
    co.gstHstNo ? `GST/HST No. ${co.gstHstNo}` : null,
    co.pstNo ? `${(doc.taxes || []).find((x) => x.id === 'RST') ? 'RST' : 'PST'} No. ${co.pstNo}` : null,
  ].filter(Boolean).join(' · ');
  const charged = t.taxes.filter((x) => x.baseCents > 0 || x.cents);
  return h('article', { class: 'doc-sheet' },
    h('header', { class: 'doc-top' },
      h('div', null,
        h('div', { class: 'doc-brand' }, co.name || 'Company'),
        h('div', { class: 'doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · ')),
        co.licenceNo ? h('div', { class: 'doc-small' }, `Licence ${co.licenceNo}`) : null,
        regs ? h('div', { class: 'doc-small' }, regs) : null),
      h('div', { class: 'doc-title' },
        h('div', { class: 'doc-kind' }, kind),
        h('div', { class: 'doc-num' }, doc.number || ''),
        h('div', { class: 'doc-small' }, kind === 'Invoice'
          ? `Issued ${fmtDate(doc.issueDate)} · Due ${fmtDate(doc.dueDate)}`
          : `Valid until ${fmtDate(doc.validUntil)}`))),
    h('section', { class: 'doc-parties' },
      h('div', null, h('div', { class: 'doc-label' }, 'Bill to'),
        h('div', { class: 'doc-strong' }, client?.name || '—'),
        client ? h('div', { class: 'doc-small' }, [client.address, client.email, client.phone].filter(Boolean).join(' · ')) : null),
      h('div', null, h('div', { class: 'doc-label' }, 'Project'),
        h('div', { class: 'doc-strong' }, doc.title || job?.title || '—'),
        job ? h('div', { class: 'doc-small' }, [job.number, job.address].filter(Boolean).join(' · ')) : null)),
    h('table', { class: 'doc-lines' },
      h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit'), h('th', { class: 'right' }, 'Amount'))),
      h('tbody', null, (doc.lines || []).map((l) => h('tr', null,
        h('td', null, l.description || ''), h('td', { class: 'right num' }, fmtNum(l.qty, Number.isInteger(Number(l.qty)) ? 0 : 2)),
        h('td', { class: 'right num' }, money(l.unitCents)), h('td', { class: 'right num' }, money(lineCents(l))))))),
    h('table', { class: 'doc-totals' }, h('tbody', null,
      tr('Subtotal', money(t.subtotalCents - t.markupCents)),
      t.markupCents ? tr('Materials adjustment', money(t.markupCents)) : null,
      charged.length ? charged.map((x) => tr(taxLabel(x, t.subtotalCents, money), money(x.cents))) : tr('Tax', money(0)),
      tr(`Total (${s.currency || 'CAD'})`, money(t.totalCents), 'grand'),
      paidCents != null ? tr('Paid', money(paidCents)) : null,
      paidCents != null ? tr('Balance due', money(t.totalCents - paidCents), 'grand') : null)),
    t.taxes.filter((x) => x.note && !x.baseCents).map((x) => h('p', { class: 'doc-small' }, x.note)),
    doc.notes ? h('section', { class: 'doc-notes' }, h('div', { class: 'doc-label' }, 'Notes'), h('p', null, doc.notes)) : null,
    extra || null,
    h('footer', { class: 'doc-foot doc-small' }, `Thank you for choosing ${co.name || 'us'}.`));
}

/** Print only the document: mounts it on body, prints, then cleans up. */
export function printDocument(opts) {
  const node = h('div', { class: 'doc-print' }, documentNode(opts));
  document.body.append(node);
  document.body.classList.add('printing-doc');
  const done = () => { node.remove(); document.body.classList.remove('printing-doc'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
}

/** Preview sheet with a Print button. */
export function previewDocument(opts) {
  const s = openSheet({
    title: `${opts.kind} ${opts.doc.number || ''}`, wide: true,
    body: h('div', { class: 'doc-preview' }, documentNode(opts)),
    actions: [button('Close', { variant: 'ghost', onClick: () => s.close() }), button('Print / save PDF', { variant: 'primary', icon: 'printer', onClick: () => printDocument(opts) })],
  });
  return s;
}

/** Debounce helper for autosave. Returns fn with .flush(). */
export function debounce(fn, ms = 400) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  return d;
}

export function clientName(store, id) { return id ? (store.get('clients', id)?.name || '—') : '—'; }
export { badge };
