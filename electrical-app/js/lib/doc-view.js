// Shared pieces for estimates and invoices: line editor, totals panel,
// price-book picker and the printable document.
import { h, clear, icon, button, fmtMoney, parseMoney, centsToInput, fmtDate, fmtNum, openSheet, searchBox, toast, badge } from '../ui.js';
import { docTotals, lineCents } from './money.js';

const KINDS = ['material', 'labour', 'other'];

/**
 * lineEditor({ doc, store, onChange, labourRateCents }) -> element
 * Mutates doc.lines in place and calls onChange() after every edit.
 */
export function lineEditor({ doc, store, onChange, readOnly = false }) {
  doc.lines = doc.lines || [];
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
    const amount = h('div', { class: 'line-amount num' }, fmtMoney(lineCents(l)));
    const refreshAmount = () => { amount.textContent = fmtMoney(lineCents(l)); };
    const desc = h('input', { class: 'input', value: l.description || '', 'aria-label': `Line ${i + 1} description`, placeholder: 'Description', readonly: readOnly,
      onInput: (e) => { l.description = e.target.value; changed(); } });
    const qty = h('input', { class: 'input num', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.qty ?? 1, 'aria-label': `Line ${i + 1} quantity`, readonly: readOnly,
      onInput: (e) => { l.qty = e.target.value === '' ? 0 : Number(e.target.value); refreshAmount(); changed(); } });
    const unit = h('input', { class: 'input num', type: 'number', step: '0.01', inputmode: 'decimal', value: centsToInput(l.unitCents), 'aria-label': `Line ${i + 1} unit price`, readonly: readOnly,
      onInput: (e) => { l.unitCents = parseMoney(e.target.value); refreshAmount(); changed(); } });
    const kind = h('select', { class: 'line-kind', 'aria-label': `Line ${i + 1} type`, disabled: readOnly,
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

/** Totals card that can be refreshed in place: el.update(doc). */
export function totalsPanel(doc, { showMarkup = true, paidCents = null } = {}) {
  const el = h('div', { class: 'totals' });
  el.update = (d) => {
    const t = docTotals(d);
    const paid = typeof paidCents === 'function' ? paidCents() : paidCents;
    clear(el);
    const row = (label, v, cls) => h('div', { class: ['totals-row', cls] }, h('span', null, label), h('span', { class: 'num' }, v));
    h(el, null,
      row('Materials', fmtMoney(t.materialCents)),
      row('Labour', fmtMoney(t.labourCents)),
      row('Other', fmtMoney(t.otherCents)),
      showMarkup && t.markupCents ? row(`Markup (${fmtNum(d.markupPct, 1)}%)`, fmtMoney(t.markupCents)) : null,
      row('Subtotal', fmtMoney(t.subtotalCents), 'strong'),
      row(`Tax (${fmtNum(d.taxPct || 0, 2)}%)`, fmtMoney(t.taxCents)),
      row('Total', fmtMoney(t.totalCents), 'grand'),
      paid != null ? row('Paid', fmtMoney(paid)) : null,
      paid != null ? row('Balance due', fmtMoney(t.totalCents - paid), 'grand') : null,
      h('div', { class: 'totals-hint muted' }, `Crew time: ${fmtNum(t.hours, 1)} h`));
  };
  el.update(doc);
  return el;
}

/** Searchable price-book picker. onPick(item) is called per click; the sheet stays open. */
export function pickItems(store, onPick) {
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
        h('span', { class: 'num' }, fmtMoney(it.priceCents)), icon('plus', 16)));
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
  const co = s.company || {};
  const client = doc.clientId ? store.get('clients', doc.clientId) : null;
  const job = doc.jobId ? store.get('jobs', doc.jobId) : null;
  const t = docTotals(doc);
  const tr = (label, v, cls) => h('tr', { class: cls }, h('td', null, label), h('td', { class: 'right num' }, v));
  return h('article', { class: 'doc-sheet' },
    h('header', { class: 'doc-top' },
      h('div', null,
        h('div', { class: 'doc-brand' }, co.name || 'Company'),
        h('div', { class: 'doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · ')),
        co.licenceNo ? h('div', { class: 'doc-small' }, `Licence ${co.licenceNo}`) : null),
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
        h('td', { class: 'right num' }, fmtMoney(l.unitCents)), h('td', { class: 'right num' }, fmtMoney(lineCents(l))))))),
    h('table', { class: 'doc-totals' }, h('tbody', null,
      tr('Subtotal', fmtMoney(t.subtotalCents - t.markupCents)),
      t.markupCents ? tr('Materials adjustment', fmtMoney(t.markupCents)) : null,
      tr(`Tax (${fmtNum(doc.taxPct || 0, 2)}%)`, fmtMoney(t.taxCents)),
      tr('Total', fmtMoney(t.totalCents), 'grand'),
      paidCents != null ? tr('Paid', fmtMoney(paidCents)) : null,
      paidCents != null ? tr('Balance due', fmtMoney(t.totalCents - paidCents), 'grand') : null)),
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
