// UI kit: a tiny DOM builder plus the primitives from replica/design/components.md.
import { icon } from './icons.js';

export { icon };

/**
 * h('div', { class: 'card', onClick: fn, style: {...}, dataset: {...} }, ...children)
 * Children may be strings, numbers, nodes, arrays, or null/false (skipped).
 * Props starting with "on" become listeners; `class`/`className` set classes;
 * booleans set or drop the attribute; everything else becomes an attribute
 * (or a property for value/checked/selected).
 */
export function h(tag, props, ...children) {
  const el = tag instanceof Node ? tag : document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate') el[k] = v;
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

// ---------- formatting ----------
let currency = 'USD';
export function setCurrency(c) { currency = c || 'USD'; }
export function fmtMoney(cents, opts = {}) {
  const v = (Number(cents) || 0) / 100;
  return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2 });
}
/** '1,234.50' or '$12' -> cents (integer). */
export function parseMoney(s) {
  if (typeof s === 'number') return Math.round(s * 100);
  const n = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
export const centsToInput = (c) => ((Number(c) || 0) / 100).toFixed(2);
export function fmtDate(d, opts) {
  if (!d) return '—';
  const date = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
  if (isNaN(date)) return '—';
  return date.toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  return isNaN(date) ? '—' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function fmtHours(h) { return `${(Math.round((Number(h) || 0) * 100) / 100).toFixed(2)} h`; }
export function fmtNum(n, d = 0) { return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); }
/** Local date as YYYY-MM-DD. */
export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localDay(d);
}
export function localDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function daysUntil(day) {
  if (!day) return Infinity;
  const a = new Date(today() + 'T00:00:00'), b = new Date(String(day).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
export function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?'; }
export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- primitives ----------
export function button(label, opts = {}) {
  const { variant = 'secondary', icon: ic, onClick, size, title, type = 'button', disabled, href } = opts;
  const cls = ['btn', variant, size, !label && ic ? 'icon' : null];
  const kids = [ic ? icon(ic, size === 'sm' ? 16 : 18) : null, label ? h('span', null, label) : null];
  if (href) return h('a', { class: cls, href, title, 'aria-label': !label ? title : null }, kids);
  return h('button', { class: cls, type, onClick, title, disabled, 'aria-label': !label ? title : null }, kids);
}

export function badge(text, tone = 'neutral') { return h('span', { class: ['badge', tone] }, text); }

/** Map a status word to a badge tone, shared so every module colours statuses the same way. */
export const STATUS_TONE = {
  new: 'info', contacted: 'info', 'site-visit': 'accent', quoted: 'accent', won: 'success', lost: 'danger',
  lead: 'neutral', scheduled: 'info', 'in-progress': 'accent', 'on-hold': 'warning', complete: 'success', invoiced: 'success',
  draft: 'neutral', sent: 'info', accepted: 'success', declined: 'danger', partial: 'warning', paid: 'success', void: 'neutral', overdue: 'danger',
  pending: 'warning', approved: 'success', rejected: 'danger', applied: 'info', issued: 'success', closed: 'neutral',
  passed: 'success', failed: 'danger', open: 'neutral', pass: 'success', fail: 'danger', na: 'neutral',
  active: 'success', done: 'neutral', stopped: 'neutral', queued: 'info', expired: 'danger', expiring: 'warning', valid: 'success',
};
export function statusBadge(status) { return badge(String(status || '—').replace(/-/g, ' '), STATUS_TONE[status] || 'neutral'); }

export function stat({ label, value, hint, tone }) {
  return h('div', { class: ['card', 'stat', tone] }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), hint ? h('span', { class: 'hint' }, hint) : null);
}

export function empty({ icon: ic = 'zap', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon(ic, 24)), h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

/** Page wrapper: page({ title, subtitle, actions: [nodes] }, ...body) */
export function page({ title, subtitle, actions = [] }, ...body) {
  return h('div', { class: 'content' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', null, title), subtitle ? h('div', { class: 'sub' }, subtitle) : null),
      actions.length ? h('div', { class: 'actions' }, actions) : null),
    body);
}

export function section(title, ...body) { return [h('h2', { class: 'section' }, title), ...body]; }

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((it) =>
    h('button', { role: 'tab', type: 'button', 'aria-selected': String(it.id === active), onClick: () => onChange(it.id) }, it.label)));
}

export function searchBox(placeholder, onInput, value = '') {
  const input = h('input', { type: 'search', placeholder, value, 'aria-label': placeholder, onInput: (e) => onInput(e.target.value) });
  return h('label', { class: 'field search' }, icon('search', 16), input);
}

/**
 * table({ columns: [{ key, label, render?(row), align?, sort?(row)->value }], rows, onRowClick?, empty? })
 * Click a header with `sort` to sort by it.
 */
export function table({ columns, rows, onRowClick, empty: emptyNode }) {
  if (!rows.length && emptyNode) return emptyNode;
  let sortKey = null, dir = 1;
  const tbody = h('tbody');
  const draw = () => {
    clear(tbody);
    let data = rows;
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      data = [...rows].sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    }
    for (const r of data) {
      tbody.append(h('tr', { class: onRowClick ? 'click' : null, onClick: onRowClick ? () => onRowClick(r) : null, tabindex: onRowClick ? 0 : null,
        onKeydown: onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : null },
        columns.map((c) => h('td', { class: c.align === 'right' ? 'right num' : null }, c.render ? c.render(r) : (r[c.key] ?? '—')))));
    }
  };
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', {
    class: [c.sort ? 'sortable' : null, c.align === 'right' ? 'right' : null],
    onClick: c.sort ? () => { dir = sortKey === c.key ? -dir : 1; sortKey = c.key; draw(); } : null,
  }, c.label))));
  draw();
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
}

// ---------- forms ----------
/**
 * field({ label, name, type, value, options, required, placeholder, step, min, max, hint, rows, span })
 * type: text | number | money | date | datetime-local | time | email | tel | select | textarea | checkbox | color
 * options: [{ value, label }] or ['a','b'].
 */
export function field(f) {
  const { label, name, type = 'text', value, options = [], required, placeholder, step, min, max, hint, rows, span, readonly } = f;
  let control;
  if (type === 'select') {
    control = h('select', { name, required }, options.map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label);
    }));
  } else if (type === 'textarea') {
    control = h('textarea', { name, required, placeholder, rows: rows || 4, readonly }, value ?? '');
  } else if (type === 'checkbox') {
    control = h('input', { type: 'checkbox', name, checked: !!value });
    return h('label', { class: ['field', 'check', span ? 'span-2' : null] }, control, h('span', null, label));
  } else {
    const isMoney = type === 'money';
    control = h('input', {
      name, required, placeholder, readonly, min, max,
      type: isMoney ? 'number' : type,
      step: isMoney ? '0.01' : step,
      inputmode: isMoney || type === 'number' ? 'decimal' : null,
      value: isMoney ? (value == null ? '' : centsToInput(value)) : (value ?? ''),
      dataset: { kind: type },
    });
  }
  return h('label', { class: ['field', span ? 'span-2' : null] }, h('span', null, label, required ? ' *' : ''), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

/** Read every named control of a form into an object. number -> Number, money -> cents, checkbox -> boolean. */
export function readForm(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    const kind = el.dataset.kind || el.type;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (kind === 'money') out[el.name] = parseMoney(el.value);
    else if (kind === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

/** formGrid(fields) -> a responsive grid of field() nodes. */
export function formGrid(fields) { return h('div', { class: 'form-grid' }, fields.map((f) => (f instanceof Node ? f : field(f)))); }

// ---------- overlays ----------
const openStack = [];
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openStack.length) openStack[openStack.length - 1](); });

/**
 * openSheet({ title, body, actions, wide, onClose }) -> { el, close, body }
 * `body` may be a node or a function (close) => node. `actions` are nodes for the footer.
 */
export function openSheet({ title, body, actions = [], wide, onClose, dialog }) {
  const prevFocus = document.activeElement;
  const scrim = h('div', { class: 'scrim', onClick: () => close() });
  const bodyEl = h('div', { class: 'sheet-body' });
  const panel = h('section', { class: [dialog ? 'dialog' : 'sheet', wide ? 'wide' : null], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'sheet-head' }, h('h2', null, title), button('', { variant: 'ghost', icon: 'x', title: 'Close', onClick: () => close() })),
    bodyEl,
    actions.length ? h('footer', { class: 'sheet-foot' }, actions) : null);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    scrim.remove(); panel.remove();
    const i = openStack.indexOf(close); if (i >= 0) openStack.splice(i, 1);
    onClose?.();
    prevFocus?.focus?.();
  }
  append(bodyEl, [typeof body === 'function' ? body(close) : body]);
  document.body.append(scrim, panel);
  openStack.push(close);
  setTimeout(() => (panel.querySelector('input,select,textarea,button:not([title=Close])') || panel).focus?.(), 30);
  return { el: panel, body: bodyEl, close };
}

/**
 * formSheet({ title, fields, submitLabel, onSubmit(values) -> false|void, danger: { label, onClick } })
 * The common "edit a record in a side sheet" pattern. Return false from onSubmit to keep it open.
 */
export function formSheet({ title, fields, submitLabel = 'Save', onSubmit, extra, danger, wide }) {
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); submit(); } }, formGrid(fields), extra || null, h('button', { type: 'submit', hidden: true }));
  const actions = [
    danger ? button(danger.label, { variant: 'ghost danger', onClick: () => { danger.onClick(); sheet.close(); } }) : null,
    h('span', { class: 'grow' }),
    button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }),
    button(submitLabel, { variant: 'primary', onClick: () => submit() }),
  ].filter(Boolean);
  const sheet = openSheet({ title, body: form, actions, wide });
  function submit() {
    if (!form.reportValidity()) return;
    if (onSubmit(readForm(form), form) !== false) sheet.close();
  }
  return sheet;
}

export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet({
      title, dialog: true, body: h('p', { style: { margin: 0 } }, message),
      actions: [
        button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
        button(okLabel, { variant: danger ? 'danger solid' : 'primary', onClick: () => { answered = true; resolve(true); s.close(); } }),
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function promptDialog(message, { title = 'Enter a value', value = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, onKeydown: (e) => { if (e.key === 'Enter') ok(); } });
    const ok = () => { done = true; resolve(input.value); s.close(); };
    const s = openSheet({ title, dialog: true, body: h('label', { class: 'field' }, h('span', null, message), input),
      actions: [button('Cancel', { variant: 'ghost', onClick: () => s.close() }), button(okLabel, { variant: 'primary', onClick: ok })],
      onClose: () => { if (!done) resolve(null); } });
  });
}

let toastHost;
export function toast(message, kind = 'info', ms = 2600) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: ['toast', kind] }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Trigger a download of text or a Blob. */
export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Pick a file; resolves to a File or null. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input); input.click();
  });
}

/** <select> of records for forms: options('clients', 'name') -> [{value,label}] with a blank first row. */
export function recordOptions(rows, labelKey = 'name', blank = '— none —') {
  return [{ value: '', label: blank }, ...rows.map((r) => ({ value: r.id, label: typeof labelKey === 'function' ? labelKey(r) : r[labelKey] }))];
}
