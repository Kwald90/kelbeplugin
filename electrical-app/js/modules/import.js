// Import and accounting export (#/import, #/import/export, #/import/history).
//
// Import: a CSV/TSV or .xlsx file of clients, price-book items, jobs or employees from another
// system (presets for Jobber, QuickBooks Online and Housecall Pro exports, or any spreadsheet):
// map columns, check every row (errors per row, duplicates by email/phone/name or SKU), then
// import in chunks so an iPad stays responsive. Each import is a batch that can be undone. The
// records sync to the server like any other change.
// Export: QuickBooks Online (Canada) import files for customers, invoices and payments, and a
// plain CSV for any bookkeeping tool. Logic lives in lib/importers.js and lib/qbo-export.js.
import { rowsFromBuffer, withHeaders, toCSV, yieldToUI } from '../lib/csv.js';
import {
  TARGETS, PRESETS, presetsFor, presetById, detectPreset, autoMap, altColumns, planRows, newPlanState, planSummary,
  detectDateOrder, templateRows, mergePatch, nameKey, normEmail,
} from '../lib/importers.js';
import {
  customerNames, customerRows, invoicesInRange, invoiceRows, paymentRows, genericInvoiceRows, splitFiles, taxKeysUsed,
  QBO_LIMITS, DEFAULT_TAX_CODES,
} from '../lib/qbo-export.js';
import { invoicePaidCents } from '../lib/money.js';
import { invoiceClientId } from './clients.js';

const BATCHES = 'import.batches';
const CHUNK = 200;
const MAX_ROWS = 20000;
const UNDO_KEEP = 10;
const COLORS = ['#8a5a00', '#1f5fb8', '#1d7044', '#7a3fb0', '#b42318', '#0f7b8a', '#c25e00', '#5f5a51'];

// ---------------------------------------------------------------------------------------
// import

function chooseStep(ctx, w, go) {
  const { ui, auth } = ctx;
  const { h } = ui;
  const targets = Object.entries(TARGETS).filter(([, t]) => auth.can(t.perm));
  if (!targets.some(([id]) => id === w.target)) w.target = targets[0]?.[0] || null;
  if (!w.target) return ui.empty({ icon: 'lock', title: 'Nothing to import', text: 'Your role cannot add clients, items, jobs or employees.' });
  const presets = presetsFor(w.target);
  if (!presets.some((p) => p.id === w.presetId)) w.presetId = presets.find((p) => p.source === 'Generic')?.id || presets[0].id;
  const fileBtn = ui.button('Choose a file', { variant: 'primary', icon: 'upload', onClick: async () => {
    const file = await ui.pickFile('.csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (file) readFile(ctx, w, file, go);
  } });
  return h('div', { class: 'stack' },
    h('div', { class: 'imp-targets', role: 'radiogroup', 'aria-label': 'What to import' }, targets.map(([id, t]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(w.target === id), class: ['card', 'imp-target', w.target === id ? 'on' : null],
      onClick: () => { w.target = id; w.presetId = null; go(); },
    }, ui.icon({ clients: 'users', items: 'box', jobs: 'briefcase', employees: 'id-card' }[id], 22), h('strong', null, t.label),
      h('span', { class: 'muted' }, { clients: 'Customers and contacts', items: 'Materials, devices and labour items', jobs: 'Open and past jobs', employees: 'Crew and office' }[id])))),
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', null, 'Exported from'),
        h('select', { name: 'preset', onChange: (e) => { w.presetId = e.target.value; } }, presets.map((p) => h('option', { value: p.id, selected: p.id === w.presetId }, p.label)))),
      h('p', { class: 'muted', style: { margin: '0' } }, 'CSV, tab-separated or Excel (.xlsx, first sheet). We recognise exports from Jobber, QuickBooks Online and Housecall Pro; any spreadsheet with a header row works too.'),
      h('div', { class: 'row' }, fileBtn,
        ui.button('Download a template', { icon: 'download', onClick: () => ui.download(`fishtape-${w.target}-template.csv`, toCSV(templateRows(w.target)), 'text/csv') })),
      w.error ? h('div', { class: 'imp-error', role: 'alert' }, ui.icon('alert', 16), w.error) : null),
    howTo(ui, w.presetId));
}

function howTo(ui, presetId) {
  const { h } = ui;
  const p = presetById(presetId);
  const tips = {
    'jobber-clients': ['In Jobber, open Clients.', 'More Actions → Export Clients. Jobber emails you a CSV.', 'Choose that file here.'],
    'qbo-customers': ['In QuickBooks Online, go to Sales → Customers (or Get paid & pay → Customers).', 'Use the Export to Excel icon above the list, or run the Customer Contact List report and export it.', 'Choose the .xlsx or a CSV saved from it.'],
    'qbo-products': ['In QuickBooks Online, go to Sales → Products and services.', 'Use the Export to Excel icon above the list.', 'Choose the .xlsx here. Sales price becomes the sell price, purchase cost the cost.'],
    'hcp-customers': ['In Housecall Pro, open Customers.', 'Actions → Export (admins only). The CSV arrives by email.', 'Choose that file here.'],
  }[p?.id];
  if (!tips) return null;
  return h('details', { class: 'card flat imp-howto' }, h('summary', null, `How to export from ${p.source}`), h('ol', null, tips.map((t) => h('li', null, t))));
}

async function readFile(ctx, w, file, go) {
  w.error = null;
  if (file.size > 25 * 1024 * 1024) { w.error = 'That file is over 25 MB. Split it into smaller files.'; go(); return; }
  try {
    const rows = await rowsFromBuffer(await file.arrayBuffer());
    const { headers, rows: body } = withHeaders(rows);
    if (!headers.length || !body.length) throw new Error('No rows found under the header row.');
    if (body.length > MAX_ROWS) throw new Error(`That file has ${body.length.toLocaleString()} rows; import up to ${MAX_ROWS.toLocaleString()} at a time.`);
    Object.assign(w, { fileName: file.name, headers, rows: body });
    const found = detectPreset(headers, w.target);
    const anyTarget = detectPreset(headers);
    if (anyTarget && anyTarget.target !== w.target && anyTarget.signature.length && ctx.auth.can(TARGETS[anyTarget.target].perm)) {
      ctx.ui.toast(`This looks like a ${anyTarget.label} file. Switched to ${TARGETS[anyTarget.target].label}.`, 'info', 4500);
      w.target = anyTarget.target; w.presetId = anyTarget.id;
    } else if (found && found.signature.length) w.presetId = found.id;
    w.map = autoMap(headers, w.target, w.presetId);
    w.map.__alts = altColumns(headers, w.presetId);
    const dateCols = TARGETS[w.target].fields.filter((f) => f.type === 'date' && w.map[f.key] >= 0).map((f) => w.map[f.key]);
    w.dateOrder = detectDateOrder(body.slice(0, 500).flatMap((r) => dateCols.map((i) => r[i]))) || (w.presetId?.startsWith('qbo') ? 'dmy' : 'mdy');
    w.step = 'map';
  } catch (e) { w.error = e.message || 'That file could not be read.'; }
  go();
}

function mapStep(ctx, w, go) {
  const { ui } = ctx;
  const { h } = ui;
  const t = TARGETS[w.target];
  const sample = (i) => { if (i < 0) return ''; for (const r of w.rows.slice(0, 20)) if (String(r[i] ?? '').trim()) return String(r[i]).slice(0, 60); return ''; };
  const hasDates = t.fields.some((f) => f.type === 'date');
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table imp-map' },
    h('thead', null, h('tr', null, h('th', null, 'Fishtape field'), h('th', null, 'Column in your file'), h('th', null, 'Example'))),
    h('tbody', null, t.fields.map((f) => {
      const ex = h('td', { class: 'muted imp-sample' }, sample(w.map[f.key]));
      return h('tr', null, h('td', null, f.label, f.required ? ' *' : ''),
        h('td', null, h('select', { 'aria-label': `Column for ${f.label}`, dataset: { field: f.key }, onChange: (e) => { w.map[f.key] = Number(e.target.value); delete w.map.__alts?.[f.key]; ex.textContent = sample(w.map[f.key]); } },
          h('option', { value: '-1' }, '— not imported —'), w.headers.map((hd, i) => h('option', { value: String(i), selected: w.map[f.key] === i }, hd)))),
        ex);
    }))));
  const opt = (label, name, value, options, onChange) => h('label', { class: 'field' }, h('span', null, label),
    h('select', { name, onChange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
  const required = t.fields.filter((f) => f.required);
  const ok = () => required.every((f) => w.map[f.key] >= 0 || (w.target === 'clients' && (w.map.company >= 0 || w.map.firstName >= 0)) || (w.target === 'employees' && w.map.firstName >= 0));
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `${w.fileName} · ${w.rows.length.toLocaleString()} rows`), ui.badge(presetById(w.presetId)?.label || 'Generic', 'info')),
      table),
    h('div', { class: 'card form-grid' },
      opt('If a record already exists', 'mode', w.mode, [['skip', 'Skip it (keep what is in Fishtape)'], ['update', 'Update it with values from the file']], (v) => { w.mode = v; }),
      hasDates ? opt('Dates like 03/04/2026 mean', 'dateOrder', w.dateOrder, [['mdy', 'Month/day/year (March 4)'], ['dmy', 'Day/month/year (3 April)']], (v) => { w.dateOrder = v; }) : null,
      w.target === 'jobs' ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: w.createClients, onChange: (e) => { w.createClients = e.target.checked; } }), h('span', null, 'Add clients that are not in Fishtape yet')) : null,
      w.target === 'items' ? h('p', { class: 'muted span-2', style: { margin: '0' } }, 'Units are tidied up (Each → ea, feet/LF → ft, per 100 ft → 100ft, per 1000 ft → 1000ft) so wire runs can price from them. Prices become exact cents.') : null),
    h('div', { class: 'row' },
      ui.button('Back', { variant: 'ghost', icon: 'chevron-left', onClick: () => { w.step = 'choose'; go(); } }), h('span', { class: 'grow' }),
      ui.button('Check rows', { variant: 'primary', icon: 'check', onClick: () => {
        if (!ok()) return ui.toast(`Pick a column for ${required.map((f) => f.label).join(', ')}`, 'error');
        runPlan(ctx, w, go);
      } })));
}

/** Validate and de-duplicate every row, in chunks with a progress bar. */
async function runPlan(ctx, w, go) {
  const { store } = ctx;
  w.step = 'checking'; w.progress = 0; go();
  const existing = store.list(TARGETS[w.target].collection);
  const state = newPlanState(w.target, existing);
  const items = [];
  for (let i = 0; i < w.rows.length; i += CHUNK) {
    const { items: part } = planRows(w.rows.slice(i, i + CHUNK), { targetId: w.target, map: w.map, dateOrder: w.dateOrder, presetId: w.presetId, mode: w.mode, state, startLine: i + 2 });
    items.push(...part);
    w.progress = Math.min(1, (i + CHUNK) / w.rows.length);
    paintProgress(w);
    await yieldToUI();
  }
  w.plan = items;
  w.filter = 'all';
  w.step = 'preview';
  go();
}

function paintProgress(w) {
  const bar = document.querySelector('.imp-progress > i');
  if (bar) bar.style.width = `${Math.round((w.progress || 0) * 100)}%`;
  const label = document.querySelector('.imp-progress-label');
  if (label) label.textContent = `${Math.round((w.progress || 0) * 100)}%`;
}

function progressStep(ui, title) {
  const { h } = ui;
  return h('div', { class: 'card stack', 'aria-busy': 'true' }, h('div', { class: 'row' }, h('strong', { class: 'grow' }, title), h('span', { class: 'muted imp-progress-label' }, '0%')),
    h('div', { class: 'progress imp-progress' }, h('i', { style: { width: '0%' } })));
}

const ACTION_LABEL = { create: ['New', 'success'], update: ['Update', 'info'], skip: ['Skip', 'neutral'], error: ['Error', 'danger'] };

function summaryCell(target, it) {
  const r = it.record || {};
  if (target === 'clients') return [r.name, r.email, r.phone].filter(Boolean).join(' · ');
  if (target === 'items') return [r.sku, r.name, r.unit, r.priceCents != null ? `$${(r.priceCents / 100).toFixed(2)}` : null].filter(Boolean).join(' · ');
  if (target === 'jobs') return [r.number, r.title, it.extra?.client, r.status].filter(Boolean).join(' · ');
  return [r.name, r.role, r.email].filter(Boolean).join(' · ');
}

function previewStep(ctx, w, go) {
  const { ui } = ctx;
  const { h } = ui;
  const s = planSummary(w.plan);
  const rows = w.plan.filter((it) => w.filter === 'all' || it.action === w.filter || (w.filter === 'warn' && it.warnings.length));
  const shown = rows.slice(0, 200);
  const problems = w.plan.filter((it) => it.action === 'error' || it.action === 'skip' || it.warnings.length);
  const downloadProblems = () => {
    const out = [[...w.headers, 'Row', 'Result', 'Problem']];
    for (const it of problems) out.push([...w.rows[it.line - 2], it.line, it.action, [...it.errors, ...it.warnings].join('; ')]);
    ui.download(`${w.fileName.replace(/\.[^.]+$/, '')}-problems.csv`, toCSV(out), 'text/csv');
  };
  const n = s.create + s.update;
  return h('div', { class: 'stack' },
    h('div', { class: 'grid imp-stats' },
      ui.stat({ label: 'New', value: s.create.toLocaleString(), tone: 'success' }),
      ui.stat({ label: 'Updates', value: s.update.toLocaleString() }),
      ui.stat({ label: 'Skipped (duplicates)', value: s.skip.toLocaleString() }),
      ui.stat({ label: 'Errors', value: s.error.toLocaleString(), tone: s.error ? 'danger' : null, hint: s.error ? 'not imported' : 'none' })),
    h('div', { class: 'row' },
      ui.tabs([{ id: 'all', label: 'All' }, { id: 'create', label: 'New' }, { id: 'update', label: 'Updates' }, { id: 'skip', label: 'Skipped' }, { id: 'error', label: 'Errors' }, { id: 'warn', label: 'Warnings' }],
        w.filter, (f) => { w.filter = f; go(); }),
      h('span', { class: 'grow' }),
      problems.length ? ui.button('Download problem rows', { size: 'sm', icon: 'download', onClick: downloadProblems }) : null),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table imp-preview' },
      h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Result'), h('th', null, TARGETS[w.target].label), h('th', null, 'Notes'))),
      h('tbody', null, shown.map((it) => h('tr', { class: it.action === 'error' ? 'imp-row-error' : null },
        h('td', { class: 'num' }, String(it.line)), h('td', null, ui.badge(...ACTION_LABEL[it.action])),
        h('td', null, summaryCell(w.target, it)),
        h('td', { class: 'imp-notes' }, [...it.errors, ...it.warnings].join('; ') || '')))))),
    rows.length > shown.length ? h('p', { class: 'muted' }, `Showing ${shown.length} of ${rows.length.toLocaleString()} rows.`) : null,
    h('div', { class: 'row' },
      ui.button('Back to columns', { variant: 'ghost', icon: 'chevron-left', onClick: () => { w.step = 'map'; go(); } }), h('span', { class: 'grow' }),
      ui.button(n ? `Import ${n.toLocaleString()} record${n === 1 ? '' : 's'}` : 'Nothing to import', { variant: 'primary', icon: 'upload', disabled: !n, onClick: () => runImport(ctx, w, go) })));
}

/** Reserve n document numbers at once (one settings write instead of n). */
function reserveNumbers(store, kind, n) {
  const s = store.settings();
  const start = s.nextNumbers?.[kind] ?? 1;
  if (n > 0) store.update('settings', 'settings', { nextNumbers: { ...s.nextNumbers, [kind]: start + n } }, { silent: true });
  const prefix = { job: 'J', estimate: 'E', invoice: 'INV' }[kind];
  return (i) => `${prefix}-${start + i}`;
}

async function runImport(ctx, w, go) {
  const { store, ui } = ctx;
  const coll = TARGETS[w.target].collection;
  const todo = w.plan.filter((it) => it.action === 'create' || it.action === 'update');
  const batch = { id: `imp-${Date.now().toString(36)}`, at: new Date().toISOString(), target: w.target, file: w.fileName, preset: w.presetId, created: {}, updated: [], counts: planSummary(w.plan), undone: null };
  const created = (c, id) => { (batch.created[c] ||= []).push(id); };
  w.step = 'importing'; w.progress = 0; go();

  // Jobs: find clients by email or name; add the missing ones when asked.
  const clientIndex = new Map();
  if (w.target === 'jobs') for (const c of store.list('clients')) { if (c.email) clientIndex.set(`e:${normEmail(c.email)}`, c.id); clientIndex.set(`n:${nameKey(c.name)}`, c.id); }
  const numbers = w.target === 'jobs' ? reserveNumbers(store, 'job', todo.filter((it) => it.action === 'create' && !it.record.number).length) : null;
  let numbered = 0;
  const shop = w.target === 'items' ? (store.list('locations').find((l) => l.kind === 'shop') || store.list('locations')[0]) : null;
  let color = store.count('employees');

  for (let i = 0; i < todo.length; i += CHUNK) {
    for (const it of todo.slice(i, i + CHUNK)) {
      const rec = { ...it.record };
      if (w.target === 'jobs') {
        const name = it.extra?.client;
        if (name || it.extra?.clientEmail) {
          let cid = (it.extra.clientEmail && clientIndex.get(`e:${normEmail(it.extra.clientEmail)}`)) || (name && clientIndex.get(`n:${nameKey(name)}`));
          if (!cid && w.createClients && name) {
            const c = store.add('clients', { name, type: 'residential', email: it.extra.clientEmail || '', phone: '', address: rec.address || '', notes: '', tags: ['imported'] }, { silent: true });
            created('clients', c.id);
            cid = c.id;
            clientIndex.set(`n:${nameKey(name)}`, cid);
            if (it.extra.clientEmail) clientIndex.set(`e:${normEmail(it.extra.clientEmail)}`, cid);
          }
          rec.clientId = cid || null;
        }
        if (it.action === 'create' && !rec.number) rec.number = numbers(numbered++);
      }
      if (w.target === 'items' && it.extra?.qtyOnHand != null && shop && it.action === 'create') rec.stock = { [shop.id]: it.extra.qtyOnHand };
      if (w.target === 'employees' && it.action === 'create') rec.color = COLORS[color++ % COLORS.length];
      if (it.action === 'create') {
        created(coll, store.add(coll, rec, { silent: true }).id);
      } else {
        const cur = store.get(coll, it.id);
        if (!cur) continue;
        const patch = mergePatch(w.target, cur, rec, it.provided);
        if (!Object.keys(patch).length) continue;
        batch.updated.push({ coll, id: it.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, cur[k] ?? null])) });
        store.update(coll, it.id, patch, { silent: true });
      }
    }
    w.progress = Math.min(1, (i + CHUNK) / todo.length);
    paintProgress(w);
    await yieldToUI();
  }
  const n = Object.values(batch.created).reduce((s, a) => s + a.length, 0);
  store.log('import', `Imported ${n} new and ${batch.updated.length} updated ${TARGETS[w.target].label.toLowerCase()} from ${w.fileName}`, coll);
  const all = [batch, ...(store.meta(BATCHES) || [])].slice(0, UNDO_KEEP);
  store.setMeta(BATCHES, all);
  await store.flush();
  w.batch = batch;
  w.step = 'done';
  ui.toast(`Imported ${n.toLocaleString()} record${n === 1 ? '' : 's'}`, 'success');
  go();
}

/** Undo a batch: remove what it created (if still there) and put back what it changed. */
export async function undoBatch(store, batchId) {
  const all = store.meta(BATCHES) || [];
  const b = all.find((x) => x.id === batchId);
  if (!b || b.undone) return null;
  let removed = 0, restored = 0, i = 0;
  // Jobs first, then the clients they created.
  const colls = Object.keys(b.created).sort((x, y) => (x === 'clients') - (y === 'clients'));
  for (const c of colls) for (const id of b.created[c]) { if (store.remove(c, id, { silent: true })) removed++; if (++i % CHUNK === 0) await yieldToUI(); }
  for (const u of b.updated) { if (store.get(u.coll, u.id)) { store.update(u.coll, u.id, u.before, { silent: true }); restored++; } }
  b.undone = new Date().toISOString();
  store.setMeta(BATCHES, all);
  store.log('import-undo', `Undid import of ${b.file}: ${removed} removed, ${restored} restored`, b.target === 'items' ? 'items' : TARGETS[b.target]?.collection || 'app');
  await store.flush();
  return { removed, restored };
}

function doneStep(ctx, w, go) {
  const { ui, store } = ctx;
  const { h } = ui;
  const b = w.batch;
  const n = Object.values(b.created).reduce((s, a) => s + a.length, 0);
  const href = { clients: '#/clients', items: '#/inventory/book', jobs: '#/jobs?status=all', employees: '#/employees' }[w.target];
  return h('div', { class: 'card stack imp-done' },
    h('h3', null, b.undone ? 'Import undone' : 'Import finished'),
    h('p', { style: { margin: '0' } }, `${n.toLocaleString()} new record${n === 1 ? '' : 's'}${b.updated.length ? `, ${b.updated.length.toLocaleString()} updated` : ''}${b.counts.skip ? `, ${b.counts.skip} skipped as duplicates` : ''}${b.counts.error ? `, ${b.counts.error} with errors left out` : ''}.`),
    store.synced ? h('p', { class: 'muted', style: { margin: '0' } }, 'They sync to the server in the background; the sync button in the rail shows progress.') : null,
    h('div', { class: 'row' },
      ui.button(`Open ${TARGETS[w.target].label.toLowerCase()}`, { variant: 'primary', icon: 'chevron-right', href }),
      b.undone ? null : ui.button('Undo this import', { variant: 'ghost danger', icon: 'undo', onClick: async () => {
        if (!(await ui.confirmDialog(`Remove the ${n.toLocaleString()} records this import added${b.updated.length ? ` and put back the ${b.updated.length} it changed` : ''}?`, { title: 'Undo import', okLabel: 'Undo import' }))) return;
        const r = await undoBatch(store, b.id);
        if (r) { b.undone = new Date().toISOString(); ui.toast(`Undone: ${r.removed} removed, ${r.restored} restored`, 'success'); }
        go();
      } }),
      ui.button('Import another file', { variant: 'ghost', icon: 'upload', onClick: () => { Object.assign(w, freshWizard(w.target)); go(); } })));
}

const freshWizard = (target = 'clients') => ({ step: 'choose', target, presetId: null, mode: 'skip', dateOrder: 'mdy', createClients: true, rows: [], headers: [], map: {}, plan: [], error: null });

function importTab(ctx, host, w) {
  const { ui } = ctx;
  const go = () => {
    ui.clear(host);
    const steps = { choose: chooseStep, map: mapStep, preview: previewStep, done: doneStep };
    if (w.step === 'checking') host.append(progressStep(ui, `Checking ${w.rows.length.toLocaleString()} rows…`));
    else if (w.step === 'importing') host.append(progressStep(ui, 'Importing…'));
    else host.append(steps[w.step](ctx, w, go));
    paintProgress(w);
  };
  go();
}

function historyTab(ctx, host) {
  const { ui, store } = ctx;
  const { h } = ui;
  const draw = () => {
    const list = store.meta(BATCHES) || [];
    ui.clear(host).append(list.length ? h('div', { class: 'list card flat', style: { padding: '0' } }, list.map((b) => {
      const n = Object.values(b.created).reduce((s, a) => s + a.length, 0);
      return h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, `${TARGETS[b.target]?.label || b.target} from ${b.file}`),
          h('div', { class: 'meta' }, `${ui.fmtDateTime(b.at)} · ${n} new · ${b.updated.length} updated${b.undone ? ` · undone ${ui.fmtDateTime(b.undone)}` : ''}`)),
        b.undone ? ui.badge('Undone') : ui.button('Undo', { size: 'sm', variant: 'ghost danger', icon: 'undo', onClick: async () => {
          if (!(await ui.confirmDialog(`Undo the import of ${b.file}? ${n} added records are removed${b.updated.length ? ` and ${b.updated.length} changed ones put back` : ''}.`, { title: 'Undo import', okLabel: 'Undo import' }))) return;
          const r = await undoBatch(store, b.id);
          if (r) ui.toast(`Undone: ${r.removed} removed, ${r.restored} restored`, 'success');
          draw();
        } }));
    })) : ui.empty({ icon: 'upload', title: 'No imports yet', text: 'The last ten imports on this device are listed here, each with Undo.' }),
    h('p', { class: 'muted' }, 'Undo works on the device that ran the import, and only removes records the import added.'));
  };
  draw();
}

// ---------------------------------------------------------------------------------------
// accounting export

function lastMonth() {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const to = new Date(d.getFullYear(), d.getMonth(), 0);
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: f(from), to: f(to) };
}

function exportTab(ctx, host) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const saved = store.settings().accounting?.qbo || {};
  const opts = { ...lastMonth(), dateFormat: saved.dateFormat || 'DD/MM/YYYY', includeDrafts: false, depositTo: saved.depositTo || 'Undeposited Funds', items: { material: 'Materials', labour: 'Labour', other: 'Other', ...(saved.items || {}) }, codes: { ...(saved.codes || {}) } };
  const canInvoices = auth.can('invoices');
  const out = h('div', { class: 'stack' });

  const data = () => {
    const clients = store.list('clients');
    const names = customerNames(clients);
    const invoices = invoicesInRange(store.list('invoices'), opts);
    return { clients, names, invoices, clientOf: (inv) => invoiceClientId(store, inv) };
  };
  const save = () => store.saveSettings({ accounting: { ...(store.settings().accounting || {}), qbo: { dateFormat: opts.dateFormat, depositTo: opts.depositTo, items: opts.items, codes: opts.codes } } });
  const stamp = () => `${opts.from}_to_${opts.to}`;
  const downloadParts = (base, files) => {
    files.forEach((rows, i) => ui.download(files.length > 1 ? `${base}-part${i + 1}.csv` : `${base}.csv`, toCSV(rows), 'text/csv'));
  };
  const problemsList = (problems) => (problems.length ? h('div', { class: 'card flat imp-problems' }, h('strong', null, `${problems.length} left out`),
    h('ul', null, problems.slice(0, 50).map((p) => h('li', null, `${p.number}: ${p.message}`)))) : null);
  const results = h('div');

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  const inp = (key, type = 'text', obj = opts) => h('input', { type, value: obj[key], onChange: (e) => { obj[key] = e.target.value; save(); drawCodes(); } });
  const codesHost = h('div');
  const drawCodes = () => {
    ui.clear(codesHost);
    if (!canInvoices) return;
    const keys = taxKeysUsed(data().invoices);
    codesHost.append(keys.length ? h('div', { class: 'stack' },
      h('strong', null, 'QuickBooks tax codes'),
      h('p', { class: 'muted', style: { margin: '0' } }, 'Each line gets the tax code for the taxes charged on it. Use the names in your QuickBooks tax list (Taxes → Sales tax settings); the import wizard lets you match them again.'),
      h('div', { class: 'form-grid' }, keys.map((k) => field(`${k.ids.join(' + ') || 'No tax'}${k.province ? ` (${k.province})` : ''}`,
        h('input', { value: opts.codes[k.key] || DEFAULT_TAX_CODES[k.key] || k.default, dataset: { taxKey: k.key }, onChange: (e) => { opts.codes[k.key] = e.target.value.trim(); save(); } }), `e.g. ${k.example}`)))) : h('p', { class: 'muted' }, 'No invoices in this date range.'));
  };

  const run = (what) => {
    const d = data();
    ui.clear(results);
    if (what === 'customers') {
      const rows = customerRows(d.clients);
      downloadParts(`qbo-customers-${ui.today()}`, splitFiles(rows, { maxRows: QBO_LIMITS.customerRows }));
      store.log('export', `QuickBooks customers CSV (${rows.length - 1} customers)`, 'clients');
      results.append(h('p', { class: 'muted' }, `${rows.length - 1} customers exported.`));
    } else if (what === 'invoices') {
      const r = invoiceRows({ invoices: d.invoices, names: d.names, items: opts.items, codes: opts.codes, dateFormat: opts.dateFormat, clientOf: d.clientOf });
      downloadParts(`qbo-invoices-${stamp()}`, splitFiles(r.rows, { maxRows: QBO_LIMITS.invoiceRows, maxInvoices: QBO_LIMITS.invoicesPerFile, keyIndex: 0 }));
      store.log('export', `QuickBooks invoices CSV ${opts.from} to ${opts.to} (${r.count} invoices)`, 'invoices');
      results.append(h('p', { class: 'muted' }, `${r.count} invoice${r.count === 1 ? '' : 's'}, ${r.rows.length - 1} lines.`), problemsList(r.problems) || '');
    } else if (what === 'payments') {
      const invoicesById = new Map(store.list('invoices').map((i) => [i.id, i]));
      const r = paymentRows({ payments: store.list('payments'), invoicesById, names: d.names, clientOf: d.clientOf, from: opts.from, to: opts.to, depositTo: opts.depositTo, dateFormat: opts.dateFormat, currency: store.settings().currency || 'CAD' });
      ui.download(`qbo-payments-${stamp()}.csv`, toCSV(r.rows), 'text/csv');
      store.log('export', `Payments CSV ${opts.from} to ${opts.to} (${r.count})`, 'payments');
      results.append(h('p', { class: 'muted' }, `${r.count} payment${r.count === 1 ? '' : 's'}.`), problemsList(r.problems) || '');
    } else if (what === 'generic') {
      const rows = genericInvoiceRows({ invoices: d.invoices, names: d.names, clientOf: d.clientOf, paidOf: (inv) => invoicePaidCents(store, inv.id) });
      ui.download(`invoices-summary-${stamp()}.csv`, toCSV(rows), 'text/csv');
      store.log('export', `Invoice summary CSV ${opts.from} to ${opts.to} (${rows.length - 1})`, 'invoices');
      results.append(h('p', { class: 'muted' }, `${rows.length - 1} invoices.`));
    }
  };

  out.append(
    h('div', { class: 'card stack' },
      h('h3', null, 'What to export'),
      h('div', { class: 'form-grid' },
        field('From (invoice or payment date)', inp('from', 'date')),
        field('To', inp('to', 'date')),
        field('Date format', h('select', { onChange: (e) => { opts.dateFormat = e.target.value; save(); } }, ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((f) => h('option', { value: f, selected: f === opts.dateFormat }, f))), 'Pick the same format in the QuickBooks import wizard'),
        field('Payments deposit to', inp('depositTo'), 'The QuickBooks account payments land in'),
        field('Product/service for material lines', inp('material', 'text', opts.items), 'Must match an item in QuickBooks exactly'),
        field('Product/service for labour lines', inp('labour', 'text', opts.items)),
        field('Product/service for other lines', inp('other', 'text', opts.items)),
        h('label', { class: 'field check' }, h('input', { type: 'checkbox', onChange: (e) => { opts.includeDrafts = e.target.checked; drawCodes(); } }), h('span', null, 'Include draft invoices'))),
      codesHost,
      h('div', { class: 'row imp-export-buttons' },
        auth.can('clients') ? ui.button('Customers (QuickBooks)', { icon: 'download', onClick: () => run('customers') }) : null,
        canInvoices ? ui.button('Invoices (QuickBooks)', { variant: 'primary', icon: 'download', onClick: () => run('invoices') }) : null,
        canInvoices ? ui.button('Payments', { icon: 'download', onClick: () => run('payments') }) : null,
        canInvoices ? ui.button('Invoice summary (any software)', { icon: 'download', onClick: () => run('generic') }) : null),
      results),
    h('div', { class: 'card stack imp-steps' },
      h('h3', null, 'Bringing it into QuickBooks Online'),
      h('ol', null,
        h('li', null, 'Import customers first: QuickBooks gear → Import data → Customers → upload the customers file → map the fields → Import. Up to 1,000 rows per file; larger exports come in parts.'),
        h('li', null, 'Make sure the products/services named above exist in QuickBooks (Sales → Products and services), with the income account you want.'),
        h('li', null, 'Turn on custom transaction numbers (Settings → Account and settings → Sales) so your invoice numbers are kept.'),
        h('li', null, 'Import invoices: gear → Import data → Invoices → upload the invoices file. Choose the date format above, choose "Exclusive of tax", and match each tax code to yours. QuickBooks takes 100 invoices and 1,000 lines per file; bigger ranges download in parts.'),
        h('li', null, 'Payments: QuickBooks has no payments import. Use the payments file as your list for + New → Receive payment, or load it with an add-on such as SaasAnt (the columns follow its Received Payments template).'),
        h('li', null, 'Check a few invoice totals. QuickBooks works out tax itself and can differ from Fishtape by a cent on some invoices.')),
      h('p', { class: 'muted', style: { margin: '0' } }, 'Formats checked against Intuit’s help pages on 2026-10-19. Negative lines (discounts, credits) can’t be imported; those invoices are listed so you can enter them by hand.')));
  host.append(out);
  drawCodes();
}

// ---------------------------------------------------------------------------------------

export default {
  id: 'import',
  title: 'Import & export',
  icon: 'upload',
  group: 'admin',
  perm: 'clients',
  render(root, ctx) {
    const { ui } = ctx;
    const { h } = ui;
    const tab = ['export', 'history'].includes(ctx.params[0]) ? ctx.params[0] : 'import';
    const body = h('div');
    root.append(ui.page({ title: 'Import & export', subtitle: 'Bring your clients, price book, jobs and crew in; send invoices and payments to your bookkeeping' },
      h('div', { class: 'row', style: { marginBottom: 'var(--s4)' } }, ui.tabs([{ id: 'import', label: 'Import' }, { id: 'export', label: 'Accounting export' }, { id: 'history', label: 'History' }], tab,
        (t) => ctx.nav(t === 'import' ? '#/import' : `#/import/${t}`))),
      body));
    if (tab === 'export') exportTab(ctx, body);
    else if (tab === 'history') historyTab(ctx, body);
    else {
      const w = freshWizard(TARGETS[ctx.query.target] ? ctx.query.target : 'clients');
      importTab(ctx, body, w);
    }
  },
};

export { PRESETS };
