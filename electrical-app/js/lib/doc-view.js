// Shared pieces for estimates and invoices: line editor, tax editor (with the exemption editor),
// totals panel, price-book picker, the printable document and the send check.
//
// Release 1 (docs/releases/r1-get-paid.md 3.2, 3.4, 4.3, 7.3, 2.6): per-line cost codes, the
// out-of-pocket line (RST off), read-only special lines (deposits, holdback release, interest),
// holdback and deposits in the totals, the progress summary block, credit-note print contents
// (Excise Tax Act s.232) and the exemption check before sending (sendCheck, confirmSend).
import { h, clear, icon, button, parseMoney, centsToInput, fmtDate, fmtNum, openSheet, searchBox, toast, badge, field, confirmDialog } from '../ui.js';
import { docTotals, lineCents, moneyFormatter, combinedPct, KINDS, invoiceKind, holdbackProblem, progressSummary, policyRule, isPassThrough, DEPOSIT_NOTES } from './money.js';
import { PROVINCES, TREATMENTS, treatmentsFor, treatmentHint, taxComponents, taxSetup, newDocTax, describeTaxes, fmtPct, provinceName, TAX_OFF_PRESETS, provincialTaxId, exemptNumberProblem, confirmedByName, jobTaxExemptFrom, exemptionConfirmedFromJob } from './tax.js';
import { EXEMPT_BASES, EXEMPT_EVIDENCE, exemptionProblem, exemptionFor, exemptionPrintLines } from './exemption.js';
import { store as appStore } from '../store.js';
import { auth } from '../auth.js';
import { emailDocAction } from '../modules/integrations.js';

const PST_PROVINCES = ['MB', 'BC', 'SK'];
const EXEMPT_TREATMENTS = ['gst-only', 'none'];
const filled = (v) => v != null && String(v).trim() !== '';
const nowIso = () => new Date().toISOString();

/** 'estimates' or 'invoices' for a document (estimates have validUntil, invoices a due date). */
export const collectionOf = (doc) => (doc && doc.validUntil !== undefined && doc.dueDate === undefined ? 'estimates' : 'invoices');
/** exemptionProblem's options for a collection (lib/exemption.js reads docType). */
const docKind = (coll) => ({ docType: coll, collection: coll });

// ---- the rules table (r1-get-paid.md 2.7) ----------------------------------------------

/** The rule rows the PWA keeps from GET /api/v1/rules/effective (store meta 'rules', written by Books); [] in demo mode. */
export function ruleRows(store = appStore) {
  try {
    const m = store?.meta?.('rules');
    if (Array.isArray(m?.rules)) return m.rules;
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}

/** A policy rule for this company: { value, unconfirmed } (unconfirmed until it is 'verified'). */
export function policyOf(key, province = null, store = appStore) {
  const r = policyRule(ruleRows(store), key, { province });
  return { value: r.value, unconfirmed: r.status !== 'verified' };
}

const UNCONFIRMED = (text) => h('span', { class: 'tax-unconfirmed' }, text);

// Parts of a screen that depend on the lines (the exemption status) refresh when the line editor
// changes the same document object: watchDoc(doc, fn) while fn's element is on the page.
const watchers = new WeakMap();
function watchDoc(doc, el, fn) {
  const list = (watchers.get(doc) || []).filter((w) => w.el.isConnected);
  list.push({ el, fn });
  watchers.set(doc, list);
}
function notifyDoc(doc) {
  const list = (watchers.get(doc) || []).filter((w) => w.el.isConnected);
  watchers.set(doc, list);
  for (const w of list) w.fn();
}

// ---- cost codes (r1-get-paid.md 2.8; the collection arrives with R1-A) ----------------------

function activeCodes(store) {
  return store.list('costCodes', (c) => c && c.active !== false)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.code || '').localeCompare(String(b.code || '')));
}

const SPECIAL_LABEL = { deposit: 'Deposit', holdback: 'Holdback release', interest: 'Interest' };

function taxOffLabel(l) {
  if (!Array.isArray(l.taxOff) || !l.taxOff.length) return null;
  return l.taxOff.includes('*') ? 'No tax on this line' : `No ${l.taxOff.join('/')} on this line`;
}

/**
 * lineEditor({ doc, store, onChange, readOnly }) -> element
 * Mutates doc.lines in place and calls onChange() after every edit. Deposit, holdback-release and
 * interest lines are read-only here (they come from their own screens); they can still be removed
 * from a draft. Out-of-pocket lines keep their kind and tax.
 */
export function lineEditor({ doc, store, onChange, readOnly = false }) {
  doc.lines = doc.lines || [];
  const money = moneyFormatter(store.settings());
  const wrap = h('div', { class: 'lines' });
  const body = h('div', { class: 'lines-body' });
  const codes = activeCodes(store);

  const draw = () => {
    clear(body);
    if (!doc.lines.length) {
      body.append(h('div', { class: 'lines-empty muted' }, 'No lines yet. Add items from the price book, a custom line, or labour.'));
    }
    doc.lines.forEach((l, i) => body.append(row(l, i)));
    refreshAdd();
  };

  const changed = (redraw) => { if (redraw) draw(); onChange?.(); notifyDoc(doc); };

  function row(l, i) {
    const special = Boolean(l.lineType);
    const pt = isPassThrough(l);
    const locked = readOnly || special;
    const amount = h('div', { class: 'line-amount num' }, money(lineCents(l)));
    const refreshAmount = () => { amount.textContent = money(lineCents(l)); };
    const desc = h('input', { class: 'input', value: l.description || '', 'aria-label': `Line ${i + 1} description`, placeholder: pt ? 'What it was (hotel, meals…)' : 'Description', readonly: locked,
      onInput: (e) => { l.description = e.target.value; changed(); } });
    const qty = h('input', { class: 'input num', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: l.qty ?? 1, 'aria-label': `Line ${i + 1} quantity`, readonly: locked,
      onInput: (e) => { l.qty = e.target.value === '' ? 0 : Number(e.target.value); refreshAmount(); changed(); } });
    const unit = h('input', { class: 'input num', type: 'number', step: '0.01', inputmode: 'decimal', value: centsToInput(l.unitCents), 'aria-label': `Line ${i + 1} unit price`, readonly: locked,
      onInput: (e) => { l.unitCents = parseMoney(e.target.value); refreshAmount(); changed(); } });
    // The kind decides how each tax applies to the line (see tax.js treatments).
    const kind = h('select', { class: 'line-kind', 'aria-label': `Line ${i + 1} type (sets how tax applies)`, title: 'Type: sets how tax applies to this line', disabled: locked || pt,
      onChange: (e) => { l.kind = e.target.value; changed(true); } },
      KINDS.map((k) => h('option', { value: k, selected: (l.kind || 'material') === k }, k)));
    const code = codes.length && !special ? h('select', { class: 'line-kind line-code', 'aria-label': `Line ${i + 1} cost code`, title: 'Cost code', disabled: readOnly,
      onChange: (e) => { l.costCodeId = e.target.value || null; changed(); } },
      h('option', { value: '', selected: !l.costCodeId }, 'No cost code'),
      codes.map((c) => h('option', { value: c.id, selected: l.costCodeId === c.id }, `${c.code} ${c.name}`)),
      l.costCodeId && !codes.some((c) => c.id === l.costCodeId) ? h('option', { value: l.costCodeId, selected: true }, 'Inactive code') : null) : null;
    const hrs = Number(l.labourHours) || 0;
    const ptTax = provincialTaxId(doc.taxProvince) || 'PST/RST';
    const ptPolicy = pt ? policyOf('tax.MB.passThroughAllowed', doc.taxProvince, store) : null;
    const offText = !pt ? taxOffLabel(l) : null;
    const meta = h('div', { class: 'line-meta' }, kind, code,
      special ? h('span', { class: 'tax-line-tag' }, SPECIAL_LABEL[l.lineType] || l.lineType) : null,
      pt ? h('span', { class: 'tax-line-tag', title: TAX_OFF_PRESETS[0].warning }, `Out-of-pocket at cost, no ${ptTax}`, ptPolicy?.unconfirmed ? UNCONFIRMED(' · unconfirmed') : null) : null,
      offText ? h('span', { class: 'tax-line-tag' }, offText) : null,
      hrs && l.kind !== 'labour' ? h('span', { class: 'muted' }, `${fmtNum(hrs, 2)} h/unit crew time`) : null,
      l.itemId ? h('span', { class: 'muted' }, 'price book') : null);
    const actions = readOnly ? h('div') : h('div', { class: 'line-actions' },
      button('', { variant: 'ghost', size: 'sm', icon: '<path d="M12 19V5M5 12l7-7 7 7"/>', title: 'Move up', disabled: i === 0,
        onClick: () => { [doc.lines[i - 1], doc.lines[i]] = [doc.lines[i], doc.lines[i - 1]]; changed(true); } }),
      button('', { variant: 'ghost', size: 'sm', icon: '<path d="M12 5v14M5 12l7 7 7-7"/>', title: 'Move down', disabled: i === doc.lines.length - 1,
        onClick: () => { [doc.lines[i + 1], doc.lines[i]] = [doc.lines[i], doc.lines[i + 1]]; changed(true); } }),
      button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Delete line',
        onClick: () => { doc.lines.splice(i, 1); changed(true); } }));
    return h('div', { class: ['line-row', special ? 'tax-line-special' : null] },
      h('div', { class: 'line-desc' }, desc, meta),
      h('label', { class: 'line-qty' }, h('span', { class: 'line-label' }, 'Qty'), qty),
      h('label', { class: 'line-unit' }, h('span', { class: 'line-label' }, 'Unit'), unit),
      h('div', { class: 'line-amt' }, h('span', { class: 'line-label' }, 'Amount'), amount),
      actions);
  }

  const head = h('div', { class: 'line-row line-head' },
    h('div', null, 'Description'), h('div', null, 'Qty'), h('div', null, 'Unit price'), h('div', { class: 'right' }, 'Amount'), h('div'));

  // The out-of-pocket line (Bulletin 031 section 3) is offered in Manitoba while the policy holds.
  const offerPassThrough = () => doc.taxProvince === 'MB' && policyOf('tax.MB.passThroughAllowed', 'MB', store).value === true;
  const ptBtn = button('Out-of-pocket', { icon: 'receipt', size: 'sm', title: TAX_OFF_PRESETS[0].label, onClick: () => {
    const p = TAX_OFF_PRESETS[0];
    doc.lines.push({ itemId: null, description: '', qty: 1, unitCents: 0, labourHours: 0, kind: p.kind, passThrough: true, taxOff: [...p.taxOff] });
    changed(true);
    toast(p.warning, 'info', 6000);
    body.querySelector('.line-row:last-child .line-desc input')?.focus();
  } });
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
    } }),
    ptBtn);
  function refreshAdd() { ptBtn.hidden = !offerPassThrough(); }

  wrap.append(head, body, addBar || '');
  draw();
  wrap.redraw = draw;
  return wrap;
}

/** Tax fields for a document: [province field, treatment field, summary, exemption]. Sets doc.taxes etc. */
export function taxEditor({ doc, store, onChange, readOnly = false, dateKey = null }) {
  const s = store.settings();
  const setup = taxSetup(s);
  const legacy = !Array.isArray(doc.taxes);
  const hasCustom = setup.custom.length > 0;
  const summary = h('div', { class: 'field span-2' });
  const exemptHost = h('div', { class: 'field span-2 tax-exempt-host' });

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
    // An exemption only stands on a document that leaves PST/RST off.
    if (!EXEMPT_TREATMENTS.includes(doc.taxTreatment) || !PST_PROVINCES.includes(doc.taxProvince)) clearExemption(doc);
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
  const drawExempt = () => {
    clear(exemptHost);
    const job = doc.jobId ? store.get('jobs', doc.jobId) : null;
    const client = doc.clientId ? store.get('clients', doc.clientId) : (job?.clientId ? store.get('clients', job.clientId) : null);
    exemptHost.append(exemptionEditor({
      doc, job, client, readOnly, store, onChange: () => onChange?.(),
      onTreatment: (treatment, extra = {}) => {
        apply(doc.taxProvince || setup.province, treatment);
        Object.assign(doc, extra);
        drawTreatment(); drawSummary(); onChange?.();
      },
    }));
    exemptHost.hidden = !exemptHost.firstChild?.childNodes?.length;
  };
  const drawSummary = () => {
    clear(summary);
    const hint = treatmentHint(doc.taxTreatment, doc.taxProvince);
    const pst = (doc.taxes || []).some((x) => ['PST', 'RST'].includes(x.id));
    h(summary, null,
      h('span', null, h('strong', null, describeTaxes(docTaxesOf(doc))), doc.taxProvince ? ` · ${provinceName(doc.taxProvince)}` : ''),
      hint ? h('span', { class: 'hint' }, hint) : null,
      pst ? h('span', { class: 'hint' }, icon('info', 14), ' PST/RST on contracting work depends on the job and the customer. Check with your accountant.') : null);
    drawExempt();
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
  const nodes = [provinceSel, treatmentHost, summary, exemptHost];
  /** Re-rate after the document date changes (rates are dated, e.g. NS HST on 2025-04-01). */
  nodes.recompute = () => {
    if (Array.isArray(doc.taxes) && doc.taxProvince && TREATMENTS[doc.taxTreatment]) { apply(doc.taxProvince, doc.taxTreatment); drawSummary(); }
  };
  /** Redraw the exemption part (after the job or client changed). */
  nodes.refreshExemption = drawExempt;
  return nodes;
}

function clearExemption(doc) {
  for (const k of ['taxExemptNumber', 'taxExemptBasis', 'taxExemptDetails', 'exemptionConfirmed']) if (doc[k] != null) doc[k] = null;
}

const docTaxesOf = (doc) => (Array.isArray(doc.taxes) ? doc.taxes : (Number(doc.taxPct) ? [{ label: 'Tax', pct: doc.taxPct }] : []));

// ---- the exemption editor (r1-get-paid.md 2.9, 3.2) -----------------------------------

const DETAIL_FIELDS = {
  'pass-on': [{ key: 'endCustomer', label: 'End customer (whose exemption it is)' }],
  federal: [{ key: 'department', label: 'Federal department' }],
  'first-nations': [
    { key: 'name', label: 'Name (person or band)' },
    { key: 'registryNo', label: 'Status registry number' },
    { key: 'band', label: 'Band' },
    { key: 'reserve', label: 'Reserve (where the work is)' },
  ],
  farm: [{ key: 'farmCertNo', label: 'Farm-use certificate number' }],
};
const NUMBER_LABEL = (basis, tax) => (basis === 'federal' ? `Federal ${tax} number` : basis === 'pass-on' ? `End customer’s ${tax} number` : `Customer’s ${tax} number`);
const needsNumber = (basis) => (EXEMPT_EVIDENCE[basis] || []).includes('number');

function basisSelect({ value, disabled, onChange, name = 'taxExemptBasis' }) {
  const sel = field({ label: 'Why it is exempt', name, type: 'select', value: value || '',
    options: [{ value: '', label: 'Choose…' }, ...EXEMPT_BASES.map((b) => ({ value: b.id, label: b.label }))] });
  const el = sel.querySelector('select');
  el.disabled = disabled;
  el.addEventListener('change', () => onChange(el.value || null));
  return sel;
}

function textField({ label, name, value, readOnly, onInput, hint }) {
  const f = field({ label, name, value: value || '', readonly: readOnly, hint });
  f.querySelector('input').addEventListener('input', (e) => onInput(e.target.value));
  return f;
}

/**
 * exemptionEditor({ doc, job, client, onChange, readOnly }) -> element
 *  - On an estimate or invoice (the default): shown when PST/RST is off (gst-only or none) in BC, SK
 *    or MB ("No tax" for a zero-rated, exempt or out-of-scope supply only while lib/exemption.js
 *    asks for evidence). Drawing never changes the document: it offers the job's exemption (a
 *    button), and the client's evidence fills in once the office ticks "This work is exempt"
 *    (exemptionConfirmed); unticking clears the evidence. When the job is exempt but the document
 *    still charges PST/RST, it offers to switch (onTreatment(treatment, extra) when given).
 *  - On a job (pass doc === job, or mode 'job'): edits job.taxExempt { basis, number, endCustomer,
 *    details, confirmedBy (the name, a string), confirmedAt, province }; onChange(job.taxExempt)
 *    after every edit.
 */
export function exemptionEditor({ doc, job = null, client = null, onChange, readOnly = false, store = appStore, mode = null, onTreatment = null }) {
  if (mode === 'job' || (job && doc === job)) return jobExemptionEditor({ job: job || doc, client, onChange, readOnly, store });
  const el = h('div', { class: 'tax-exempt' });
  const draw = () => {
    clear(el);
    const prov = doc.taxProvince;
    if (!PST_PROVINCES.includes(prov)) return;
    // "No tax" for a zero-rated, exempt or out-of-scope supply is not an exemption, unless
    // lib/exemption.js still asks for evidence: then the editor shows so it can be entered.
    if (doc.taxTreatment === 'none' && ['zero', 'exempt', 'out_of_scope'].includes(doc.taxNoneReason)
      && !exemptionProblem(doc, docKind(collectionOf(doc)))) return;
    const tax = provincialTaxId(prov);
    const jobEx = exemptionFor({ job, client, province: prov });
    if (!EXEMPT_TREATMENTS.includes(doc.taxTreatment)) {
      if (!jobEx.taxExemptBasis) return;
      const onReserve = jobEx.taxExemptBasis === 'first-nations' && filled(jobEx.taxExemptDetails?.reserve);
      h(el, null, h('div', { class: 'tax-exempt-note' }, icon('info', 16),
        h('span', null, `${job?.number || 'This job'} is marked exempt from ${tax} (${exemptionPrintLines({ ...jobEx, taxProvince: prov })[0]}). This document still charges ${tax}.`),
        readOnly ? null : button('Use the job’s exemption', { size: 'sm', onClick: () => {
          const treatment = onReserve ? 'none' : 'gst-only';
          const extra = { ...jobEx, exemptionConfirmed: exemptionConfirmedFromJob(job), ...(onReserve ? { taxNoneReason: 'relief' } : {}) };
          if (onTreatment) onTreatment(treatment, extra);
          else {
            doc.taxes = taxComponents({ province: prov, treatment, date: doc.issueDate || new Date() });
            doc.taxTreatment = treatment;
            doc.taxPct = combinedPct(doc.taxes.filter((t) => t.applies.material || t.applies.labour || t.applies.other));
            Object.assign(doc, extra);
            draw(); onChange?.();
          }
        } })));
      return;
    }
    // A job that says the work is exempt: offered to a document with no exemption yet. Drawing
    // never changes the document (new documents get it from newDocTax); the office clicks.
    const offerJob = !readOnly && !doc.taxExemptBasis && !filled(doc.taxExemptNumber) && jobEx.taxExemptBasis
      ? h('div', { class: 'tax-exempt-note' }, icon('info', 16),
        h('span', null, `${job?.number || 'This job'} is marked exempt (${exemptionPrintLines({ ...jobEx, taxProvince: prov })[0]}).`),
        button('Use the job’s exemption', { size: 'sm', onClick: () => {
          Object.assign(doc, jobEx, { exemptionConfirmed: exemptionConfirmedFromJob(job) });
          draw(); onChange?.();
        } }))
      : null;
    const confirmed = Boolean(doc.exemptionConfirmed);
    const tick = h('input', { type: 'checkbox', name: 'exemptionConfirmed', checked: confirmed, disabled: readOnly,
      onChange: (e) => {
        if (e.target.checked) {
          // The client's evidence on file fills what the document doesn't have yet.
          if (!doc.taxExemptBasis && client?.taxExemptBasis) doc.taxExemptBasis = client.taxExemptBasis;
          if (!filled(doc.taxExemptNumber) && filled(client?.taxExemptNumber)) doc.taxExemptNumber = client.taxExemptNumber;
          if (client?.taxExemptDetails) doc.taxExemptDetails = { ...client.taxExemptDetails, ...(doc.taxExemptDetails || {}) };
          doc.exemptionConfirmed = { by: confirmedByName(auth.who()), at: nowIso() };
        } else clearExemption(doc); // unticked: the evidence goes too, so nothing prints or passes the send check

        draw(); onChange?.();
      } });
    const status = h('div', { class: 'tax-exempt-status', role: 'status' });
    const drawStatus = () => {
      clear(status);
      const p = exemptionProblem(doc, docKind(collectionOf(doc)));
      const fmt = exemptNumberProblem({ province: prov, basis: doc.taxExemptBasis, number: doc.taxExemptNumber });
      const lines = exemptionPrintLines(doc);
      h(status, null,
        p ? h('div', { class: ['tax-exempt-msg', p.level === 'block' ? 'block' : 'warn'] }, icon('alert', 14), h('span', null, p.message)) : null,
        fmt ? h('div', { class: 'tax-exempt-msg warn' }, icon('info', 14), h('span', null, fmt)) : null,
        !p && lines.length ? h('div', { class: 'tax-exempt-msg ok' }, icon('check', 14), h('span', null, `Prints on the document: ${lines.join(' · ')}`)) : null);
    };
    const set = (k, v) => { doc[k] = v; drawStatus(); onChange?.(); };
    const setDetail = (k, v) => { doc.taxExemptDetails = { ...(doc.taxExemptDetails || {}), [k]: v }; drawStatus(); onChange?.(); };
    const basis = doc.taxExemptBasis;
    const sourceNote = doc.exemptionConfirmed?.from === 'job'
      ? `From ${job?.number || 'the job'}${doc.exemptionConfirmed.by ? `, confirmed by ${doc.exemptionConfirmed.by}` : ''}.`
      : doc.exemptionConfirmed?.by ? `Confirmed by ${doc.exemptionConfirmed.by} ${fmtDate(doc.exemptionConfirmed.at)}.` : null;
    h(el, null,
      h('div', { class: 'tax-exempt-head' }, h('strong', null, `${tax} exemption`), h('span', { class: 'muted' }, ' · for this contract only')),
      offerJob,
      h('label', { class: 'field check' }, tick, h('span', null, 'This work is exempt')),
      sourceNote ? h('div', { class: 'muted tax-exempt-src' }, sourceNote) : null,
      h('div', { class: 'form-grid tax-exempt-grid' },
        basisSelect({ value: basis, disabled: readOnly, onChange: (v) => { doc.taxExemptBasis = v; draw(); onChange?.(); } }),
        basis && !needsNumber(basis) && basis !== 'federal' ? null
          : textField({ label: NUMBER_LABEL(basis, tax), name: 'taxExemptNumber', value: doc.taxExemptNumber, readOnly, onInput: (v) => set('taxExemptNumber', v.trim() || null),
            hint: prov === 'MB' ? '7 digits (Bulletin 004)' : null }),
        (DETAIL_FIELDS[basis] || []).map((f) => textField({ label: f.label, name: `taxExemptDetails.${f.key}`, value: doc.taxExemptDetails?.[f.key], readOnly, onInput: (v) => setDetail(f.key, v.trim() || null) }))),
      status);
    drawStatus();
    watchDoc(doc, status, drawStatus);
  };
  draw();
  el.redraw = draw;
  return el;
}

function jobExemptionEditor({ job, client, onChange, readOnly, store }) {
  const el = h('div', { class: 'tax-exempt tax-exempt-job' });
  const prov = store?.settings?.()?.company?.province || null;
  const tax = provincialTaxId(prov) === 'PST' ? 'PST' : 'RST';
  const save = () => onChange?.(job.taxExempt || null);
  const draw = () => {
    clear(el);
    const ex = job.taxExempt || null;
    const tick = h('input', { type: 'checkbox', name: 'taxExempt', checked: Boolean(ex?.basis), disabled: readOnly,
      onChange: (e) => {
        if (e.target.checked) job.taxExempt = jobTaxExemptFrom({ client, by: auth.who(), province: prov, at: nowIso() });
        else job.taxExempt = null;
        draw(); save();
      } });
    const status = h('div', { class: 'tax-exempt-status', role: 'status' });
    const drawStatus = () => {
      clear(status);
      const cur = job.taxExempt;
      if (!cur) return;
      const asDoc = { taxProvince: prov, taxExemptBasis: cur.basis, taxExemptNumber: cur.number, taxExemptDetails: { ...(cur.details || {}), endCustomer: cur.endCustomer } };
      const missing = [];
      for (const need of EXEMPT_EVIDENCE[cur.basis] || ['basis']) {
        const keys = Array.isArray(need) ? need : [need];
        if (!keys.some((k) => filled(k === 'number' ? asDoc.taxExemptNumber : k === 'basis' ? cur.basis : asDoc.taxExemptDetails[k]))) missing.push(keys.join(' or '));
      }
      const fmt = exemptNumberProblem({ province: prov, basis: cur.basis, number: cur.number });
      h(status, null,
        missing.length ? h('div', { class: 'tax-exempt-msg warn' }, icon('alert', 14), h('span', null, `Still needed: ${missing.join(', ')}. Invoices on this job can't be sent without it.`)) : null,
        fmt ? h('div', { class: 'tax-exempt-msg warn' }, icon('info', 14), h('span', null, fmt)) : null,
        !missing.length ? h('div', { class: 'tax-exempt-msg ok' }, icon('check', 14), h('span', null, `New estimates and invoices on this job leave ${tax} off and print: ${exemptionPrintLines(asDoc).join(' · ')}`)) : null,
        confirmedByName(cur.confirmedBy) ? h('div', { class: 'muted tax-exempt-src' }, `Confirmed by ${confirmedByName(cur.confirmedBy)} ${fmtDate(cur.confirmedAt)}.`) : null);
    };
    const touch = () => {
      Object.assign(job.taxExempt, { confirmedBy: confirmedByName(auth.who()), confirmedAt: nowIso(), province: job.taxExempt.province || prov || null });
      drawStatus(); save();
    };
    h(el, null,
      h('label', { class: 'field check' }, tick, h('span', null, `This job’s work is exempt from ${tax}`)),
      ex ? h('div', { class: 'form-grid tax-exempt-grid' },
        basisSelect({ value: ex.basis, disabled: readOnly, onChange: (v) => { job.taxExempt.basis = v; touch(); draw(); } }),
        ex.basis && !needsNumber(ex.basis) && ex.basis !== 'federal' ? null
          : textField({ label: NUMBER_LABEL(ex.basis, tax), name: 'taxExempt.number', value: ex.number, readOnly, onInput: (v) => { job.taxExempt.number = v.trim() || null; touch(); } }),
        (DETAIL_FIELDS[ex.basis] || []).map((f) => (f.key === 'endCustomer'
          ? textField({ label: f.label, name: 'taxExempt.endCustomer', value: ex.endCustomer, readOnly, onInput: (v) => { job.taxExempt.endCustomer = v.trim() || null; touch(); } })
          : textField({ label: f.label, name: `taxExempt.details.${f.key}`, value: ex.details?.[f.key], readOnly, onInput: (v) => { job.taxExempt.details = { ...(job.taxExempt.details || {}), [f.key]: v.trim() || null }; touch(); } })))) : null,
      ex ? status : h('p', { class: 'muted tax-exempt-src' }, `${tax} is charged on this job. Tick the box only when this contract is exempt (Bulletin 031): the client’s evidence on file is not enough by itself.`));
    drawStatus();
  };
  draw();
  el.redraw = draw;
  return el;
}

// ---- sending (r1-get-paid.md 2.9, 3.2) ------------------------------------------------

/**
 * Before an estimate or invoice is sent: { block, warn } (strings or null). Blocks a Manitoba
 * invoice that leaves RST off without the exemption's evidence, and an invoice whose holdback
 * can't stand; warns on Manitoba estimates and in BC and SK. The server refuses the same invoices.
 */
export function sendCheck(doc, { collection = null } = {}) {
  const coll = collection || collectionOf(doc);
  const p = exemptionProblem(doc, docKind(coll));
  const hp = coll === 'invoices' ? holdbackProblem(doc) : null;
  return {
    block: p?.level === 'block' ? p.message : hp ? hp.message : null,
    warn: p?.level === 'warn' ? p.message : null,
  };
}

/**
 * sendCheck with the dialogs: resolves true when the document may be sent. A block shows why,
 * with the province's hint for "PST/RST exempt, GST charged"; a warning asks "Send anyway".
 */
export async function confirmSend(doc, { collection = null, what = null } = {}) {
  const c = sendCheck(doc, { collection });
  const label = what || (collectionOf(doc) === 'estimates' ? 'estimate' : 'invoice');
  if (c.block) {
    const hint = EXEMPT_TREATMENTS.includes(doc.taxTreatment) ? treatmentHint('gst-only', doc.taxProvince) : '';
    await new Promise((resolve) => {
      const s = openSheet({
        title: `This ${label} can’t be sent yet`, dialog: true, onClose: resolve,
        body: h('div', { class: 'stack tax-send-block', dataset: { sendBlock: '1' } }, h('p', null, c.block), hint ? h('p', { class: 'muted' }, hint) : null),
        actions: [h('span', { class: 'grow' }), button('OK', { variant: 'primary', onClick: () => s.close() })],
      });
    });
    return false;
  }
  if (c.warn) return confirmDialog(c.warn, { title: `Send this ${label}?`, okLabel: 'Send anyway', danger: false });
  return true;
}

/** Label for a tax row: "GST 5%", plus "on $1,200.00" when it doesn't apply to the whole subtotal. */
function taxLabel(t, subtotalCents, money) {
  return `${t.label} ${fmtPct(t.pct)}%${t.baseCents !== subtotalCents ? ` on ${money(t.baseCents)}` : ''}`;
}

const deferredNames = (t) => t.taxes.filter((x) => x.deferredCents).map((x) => x.label);
const listJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const holdbackLabel = (d) => `${invoiceKind(d) === 'credit' ? 'Holdback adjustment' : 'Holdback retained'}${Number(d.holdback?.pct) ? ` (${fmtPct(d.holdback.pct)}%)` : ''}`;

/** Totals card that can be refreshed in place: el.update(doc). */
export function totalsPanel(doc, { showMarkup = true, paidCents = null, money = moneyFormatter(null) } = {}) {
  const el = h('div', { class: 'totals' });
  el.update = (d) => {
    const t = docTotals(d);
    const paid = typeof paidCents === 'function' ? paidCents() : paidCents;
    clear(el);
    const row = (label, v, cls) => h('div', { class: ['totals-row', cls] }, h('span', null, label), h('span', { class: 'num' }, v));
    const charged = t.taxes.filter((x) => x.baseCents || x.cents);
    const otherWork = t.otherCents - t.depositCents - t.holdbackLineCents - t.interestCents;
    const deferred = deferredNames(t);
    const rstDeferred = t.taxes.some((x) => x.deferredCents && ['RST', 'PST'].includes(x.id));
    const rstRule = d.taxProvince === 'MB' ? 'tax.MB.rstHoldbackAtRelease' : d.taxProvince === 'SK' ? 'tax.SK.pstHoldbackAtRelease' : d.taxProvince === 'BC' ? 'tax.BC.pstHoldbackAtRelease' : null;
    const rstUnconfirmed = rstDeferred && rstRule && policyOf(rstRule, d.taxProvince).unconfirmed;
    const hp = holdbackProblem(d);
    const kind = invoiceKind(d);
    h(el, null,
      row('Materials', money(t.materialCents)),
      row('Labour', money(t.labourCents)),
      row('Other', money(otherWork)),
      t.passThroughCents ? h('div', { class: 'totals-hint muted' }, `Includes ${money(t.passThroughCents)} out-of-pocket at cost (no ${provincialTaxId(d.taxProvince) || 'PST/RST'})`) : null,
      showMarkup && t.markupCents ? row(`Markup (${fmtNum(d.markupPct, 1)}%)`, money(t.markupCents)) : null,
      t.depositCents ? row(kind === 'deposit' ? 'Deposit' : 'Deposits applied', money(t.depositCents)) : null,
      t.holdbackLineCents ? row('Holdback release', money(t.holdbackLineCents)) : null,
      t.interestCents ? row('Interest', money(t.interestCents)) : null,
      row('Subtotal', money(t.subtotalCents), 'strong'),
      t.holdbackCents ? row(holdbackLabel(d), money(-t.holdbackCents)) : null,
      t.holdbackCents ? row('Net before tax', money(t.netSubtotalCents), 'strong') : null,
      charged.length ? charged.map((x) => row(taxLabel(x, t.netSubtotalCents, money), money(x.cents))) : row('Tax', money(0)),
      row('Total', money(t.totalCents), 'grand'),
      paid != null ? row('Paid', money(paid)) : null,
      paid != null ? row('Balance due', money(t.totalCents - paid), 'grand') : null,
      deferred.length ? h('div', { class: 'totals-hint muted' }, `${listJoin(deferred)} on the holdback ${deferred.length > 1 ? 'are' : 'is'} charged on the release invoice.`) : null,
      rstUnconfirmed ? h('div', { class: 'totals-hint tax-unconfirmed' }, 'Unconfirmed: if your accountant says RST is due at billing, change this on Books → Rules.') : null,
      hp ? h('div', { class: 'totals-hint tax-exempt-msg block' }, icon('alert', 14), h('span', null, hp.message)) : null,
      kind === 'deposit' ? h('div', { class: 'totals-hint muted' }, DEPOSIT_NOTES[d.depositModel === 'security' ? 'security' : 'prepayment']) : null,
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

const KIND_TITLE = { credit: 'Credit note', deposit: 'Deposit invoice', progress: 'Progress invoice', 'holdback-release': 'Holdback release invoice', interest: 'Interest invoice' };
const CREDIT_REASON_LABEL = { error: 'Correction of an error', price: 'Price adjustment', dispute: 'Disputed amount', backcharge: 'Back-charge', bad_debt: 'Bad debt write-off', 'deposit-refund': 'Deposit refund', other: 'Adjustment' };

/** The progress summary block for a printed invoice, or null (r1-get-paid.md 7.3). */
function progressBlock(doc, store, money) {
  const job = doc.jobId ? store.get('jobs', doc.jobId) : null;
  const kind = invoiceKind(doc);
  if (!job || !(kind === 'progress' || docTotals(doc).holdbackCents)) return null;
  const p = progressSummary(doc, { job, invoices: store.list('invoices', (i) => i.jobId === job.id) });
  if (!p) return null;
  const tr = (label, v, cls) => h('tr', { class: cls }, h('td', null, label), h('td', { class: 'right num' }, v));
  return h('section', { class: 'doc-notes tax-progress', dataset: { progress: '1' } },
    h('div', { class: 'doc-label' }, 'Contract summary'),
    h('table', { class: 'doc-totals tax-progress-table' }, h('tbody', null,
      tr('Original contract', money(p.originalContractCents)),
      p.changeOrdersCents ? tr('Approved change orders', money(p.changeOrdersCents)) : null,
      tr('Contract to date', money(p.contractCents), 'strong'),
      tr('Previously billed', money(p.previousCents)),
      tr('This invoice', money(p.thisCents)),
      tr(`Billed to date${p.pctBilled != null ? ` (${fmtNum(p.pctBilled, 1)}%)` : ''}`, money(p.billedToDateCents)),
      tr('Holdback retained to date', money(p.holdbackRetainedCents)),
      tr('Balance to finish', money(p.balanceToFinishCents), 'grand'))),
    h('p', { class: 'doc-small' }, 'Amounts before tax. Billed amounts are gross of holdback.'));
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
  const invKind = kind === 'Invoice' ? invoiceKind(doc) : null;
  const title = (invKind && KIND_TITLE[invKind]) || kind;
  const isCredit = invKind === 'credit';
  const provTax = (doc.taxes || []).some((x) => x.id === 'RST') || doc.taxProvince === 'MB' ? 'RST' : 'PST';
  // CRA: an invoice must show the supplier's GST/HST registration number for the
  // customer to claim input tax credits. PST numbers are shown when set.
  const regs = [
    co.gstHstNo ? `GST/HST No. ${co.gstHstNo}` : null,
    co.pstNo ? `${provTax} No. ${co.pstNo}` : null,
  ].filter(Boolean).join(' · ');
  const charged = t.taxes.filter((x) => x.baseCents || x.cents);
  const ptSuffix = ` (at cost, no ${provincialTaxId(doc.taxProvince) || 'PST/RST'})`;
  const exemptLines = EXEMPT_TREATMENTS.includes(doc.taxTreatment) ? exemptionPrintLines(doc) : [];
  const orig = isCredit && doc.creditsInvoiceId ? store.get('invoices', doc.creditsInvoiceId) : null;
  const origNumber = doc.creditTaxSnapshot?.invoiceNumber || orig?.number || null;
  const origDate = doc.creditTaxSnapshot?.invoiceDate || orig?.issueDate || null;
  const deferred = deferredNames(t);
  const period = doc.periodFrom || doc.periodTo ? `Work period ${fmtDate(doc.periodFrom)} to ${fmtDate(doc.periodTo)}` : null;
  return h('article', { class: 'doc-sheet' },
    h('header', { class: 'doc-top' },
      h('div', null,
        h('div', { class: 'doc-brand' }, co.name || 'Company'),
        h('div', { class: 'doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · ')),
        co.licenceNo ? h('div', { class: 'doc-small' }, `Licence ${co.licenceNo}`) : null,
        regs ? h('div', { class: 'doc-small' }, regs) : null),
      h('div', { class: 'doc-title' },
        h('div', { class: 'doc-kind' }, title),
        h('div', { class: 'doc-num' }, doc.number || ''),
        h('div', { class: 'doc-small' }, kind === 'Invoice'
          ? (isCredit ? `Issued ${fmtDate(doc.issueDate)}` : `Issued ${fmtDate(doc.issueDate)} · Due ${fmtDate(doc.dueDate)}`)
          : `Valid until ${fmtDate(doc.validUntil)}`),
        isCredit && origNumber ? h('div', { class: 'doc-small' }, `Credits invoice ${origNumber}${origDate ? ` of ${fmtDate(origDate)}` : ''}`) : null)),
    h('section', { class: 'doc-parties' },
      h('div', null, h('div', { class: 'doc-label' }, isCredit ? 'Credit to' : 'Bill to'),
        h('div', { class: 'doc-strong' }, client?.name || '—'),
        client ? h('div', { class: 'doc-small' }, [client.address, client.email, client.phone].filter(Boolean).join(' · ')) : null),
      h('div', null, h('div', { class: 'doc-label' }, 'Project'),
        h('div', { class: 'doc-strong' }, doc.title || job?.title || '—'),
        job ? h('div', { class: 'doc-small' }, [job.number, job.address].filter(Boolean).join(' · ')) : null,
        doc.contractRef ? h('div', { class: 'doc-small' }, `Contract ${doc.contractRef}`) : null,
        period ? h('div', { class: 'doc-small' }, period) : null)),
    isCredit ? h('section', { class: 'doc-notes tax-credit', dataset: { creditNote: '1' } },
      h('div', { class: 'doc-label' }, 'Reason'),
      h('p', null, CREDIT_REASON_LABEL[doc.creditReason] || 'Adjustment'),
      h('p', { class: 'doc-small' }, `Tax adjusted: ${charged.length ? charged.map((x) => `${x.label} ${money(x.cents)}`).join(' · ') : 'none'}`)) : null,
    h('table', { class: 'doc-lines' },
      h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit'), h('th', { class: 'right' }, 'Amount'))),
      h('tbody', null, (doc.lines || []).map((l) => h('tr', null,
        h('td', null, `${l.description || ''}${isPassThrough(l) ? ptSuffix : ''}`), h('td', { class: 'right num' }, fmtNum(l.qty, Number.isInteger(Number(l.qty)) ? 0 : 2)),
        h('td', { class: 'right num' }, money(l.unitCents)), h('td', { class: 'right num' }, money(lineCents(l))))))),
    h('table', { class: 'doc-totals' }, h('tbody', null,
      tr('Subtotal', money(t.subtotalCents - t.markupCents)),
      t.markupCents ? tr('Materials adjustment', money(t.markupCents)) : null,
      t.holdbackCents ? tr(holdbackLabel(doc), money(-t.holdbackCents)) : null,
      t.holdbackCents ? tr('Net before tax', money(t.netSubtotalCents)) : null,
      charged.length ? charged.map((x) => tr(taxLabel(x, t.netSubtotalCents, money), money(x.cents))) : tr('Tax', money(0)),
      tr(`Total (${s.currency || 'CAD'})`, money(t.totalCents), 'grand'),
      paidCents != null && !isCredit ? tr('Paid', money(paidCents)) : null,
      paidCents != null && !isCredit ? tr('Balance due', money(t.totalCents - paidCents), 'grand') : null)),
    t.taxes.filter((x) => x.note && !x.baseCents).map((x) => h('p', { class: 'doc-small' }, x.note)),
    exemptLines.length ? h('section', { class: 'doc-small tax-exempt-print', dataset: { exemption: '1' } }, exemptLines.map((x) => h('div', null, x))) : null,
    deferred.length && t.holdbackCents > 0 ? h('p', { class: 'doc-small' }, `${listJoin(deferred)} on the holdback ${deferred.length > 1 ? 'are' : 'is'} charged when the holdback is released.`) : null,
    invKind === 'deposit' ? h('p', { class: 'doc-small' }, DEPOSIT_NOTES[doc.depositModel === 'security' ? 'security' : 'prepayment']) : null,
    kind === 'Invoice' && !isCredit ? progressBlock(doc, store, money) : null,
    doc.notes ? h('section', { class: 'doc-notes' }, h('div', { class: 'doc-label' }, 'Notes'), h('p', null, doc.notes)) : null,
    extra || null,
    h('footer', { class: 'doc-foot doc-small' }, `Thank you for choosing ${co.name || 'us'}.`));
}

/** Print one node alone: mounts it on body, prints, then cleans up. */
export function printNode(content) {
  const node = h('div', { class: 'doc-print' }, content);
  document.body.append(node);
  document.body.classList.add('printing-doc');
  const done = () => { node.remove(); document.body.classList.remove('printing-doc'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
}

/** Print only the document. */
export function printDocument(opts) {
  printNode(documentNode(opts));
}

/** Preview sheet with a Print button. */
export function previewDocument(opts) {
  const s = openSheet({
    title: `${opts.kind} ${opts.doc.number || ''}`, wide: true,
    body: h('div', { class: 'doc-preview' }, documentNode(opts)),
    actions: [button('Close', { variant: 'ghost', onClick: () => s.close() }), emailDocAction(opts), button('Print / save PDF', { variant: 'primary', icon: 'printer', onClick: () => printDocument(opts) })],
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
