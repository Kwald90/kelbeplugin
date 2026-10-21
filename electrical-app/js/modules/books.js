// Books (#/books): the month-end controls (docs/releases/r1-get-paid.md 2.6-2.8, 8.1, 8.2;
// docs/office/period-lock.md, rules-table.md, cost-codes.md).
//   #/books             the closing date: who closed what and when, QuickBooks' own dates, the
//                       pre-close checklist before "Close", late postings, refused writes, history
//   #/books/payroll     payroll runs (reopen: owners and admins), the Late hours queue, payroll
//                       locks waiting for a connection, vacation and holiday pay modes
//   #/books/rules       the rules table in force, with company overrides
//   #/books/cost-codes  the company's cost codes and each job's current phase
// Office tools that change shared state on the server need a connection and say so; the server
// refuses everything this screen hides (closing routes, write guards). No money is shown here.
import { endOfLastMonth, locksFrom, isLateHours, zoneFor, dayIn, REVERSAL_ACTION } from '../lib/closing.js';
import { RULE_DEFS, RULE_STATUS, resolveRules, ruleValueText, ruleProblem, ruleRecordProblem } from '../lib/rules.js';
import { STANDARD_COST_CODES, COST_CODE_GROUPS, activeCostCodes, costCodeLabel, costCodeProblem, missingStandardCodes } from '../lib/cost-codes.js';
import { entryMinutes, fmtH, isCorrection, entryDay } from '../lib/timesheet.js';

export const PENDING_RUNS_META = 'pendingPayrollRuns';
const RULES_META = 'rulesTable';

/** The module's stylesheet (loaded by the module, so index.html does not change). */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/books.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/books.css';
  document.head.append(link);
}

const SECTIONS = [
  { id: 'closing', label: 'Closing date', href: '#/books' },
  { id: 'payroll', label: 'Payroll', href: '#/books/payroll' },
  { id: 'rules', label: 'Rules', href: '#/books/rules' },
  { id: 'cost-codes', label: 'Cost codes', href: '#/books/cost-codes' },
];

const PREFLIGHT_LABEL = {
  timeOpen: 'Time entries open or not approved', devicesBehind: 'Shared devices not seen since then', draftInvoices: 'Draft invoices dated in the period',
  draftBills: 'Bills still in draft', countsNotPosted: 'Stock counts counted but not posted', ticketsUnpriced: 'Signed or refused tickets not priced or billed',
  openDisputes: 'Open disputes on invoices',
};
const COLL_LABEL = { payments: 'Payment', bills: 'Bill', stockMoves: 'Stock move', timeEntries: 'Time entry', equipmentUse: 'Equipment use', stockCounts: 'Stock count', invoices: 'Invoice', jobs: 'Job' };

/** The company's zone and today in it. */
const zoneOf = (store) => zoneFor(store.settings()?.company?.province);
const todayOf = (store) => dayIn(new Date().toISOString(), zoneOf(store));

/** Late hours: entries on or before payroll's exported-through date that no run has taken. */
export function lateHours(store) {
  const locks = locksFrom(store.settings(), store.list('payrollRuns'));
  const zone = zoneOf(store);
  return store.list('timeEntries', (e) => (e.clockOut || isCorrection(e)) && isLateHours(e, locks, { zone }))
    .sort((a, b) => String(entryDay(a)).localeCompare(String(entryDay(b))));
}

export default {
  id: 'books',
  title: 'Books',
  icon: 'lock',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    ensureStyles();
    const section = SECTIONS.some((s) => s.id === ctx.params[0]) ? ctx.params[0] : 'closing';
    const host = ctx.ui.h('div');
    root.append(host);
    const draw = () => {
      const { ui, nav } = ctx;
      const body = ui.h('div', { class: 'books' });
      ui.clear(host).append(ui.page({ title: 'Books', subtitle: 'Month-end: the closing date, payroll runs, the rules table and cost codes' },
        ui.h('div', { class: 'ops-tabs-row' }, ui.tabs(SECTIONS.map(({ id, label }) => ({ id, label })), section, (id) => nav(SECTIONS.find((s) => s.id === id).href))),
        body));
      if (section === 'payroll') payrollSection(body, ctx, draw);
      else if (section === 'rules') rulesSection(body, ctx, draw);
      else if (section === 'cost-codes') costCodesSection(body, ctx, draw);
      else closingSection(body, ctx, draw);
    };
    draw();
    let pending = null;
    const later = () => { clearTimeout(pending); pending = setTimeout(draw, 80); };
    const watch = { closing: ['settings'], payroll: ['payrollRuns', 'timeEntries', 'settings'], rules: ['rules'], 'cost-codes': ['costCodes', 'jobs', 'settings'] }[section];
    const offs = watch.map((c) => ctx.store.on(c, later));
    return () => { offs.forEach((f) => f()); clearTimeout(pending); };
  },
};

// ---- helpers -------------------------------------------------------------------------------

function offline(ui, text) {
  return ui.h('div', { class: 'card books-note' }, ui.icon('info', 18), ui.h('p', null, text));
}

async function serverCall(ctx, fn, failText) {
  try { return await fn(ctx.app.api); } catch (e) {
    ctx.ui.toast(e.code === 'offline' ? `${failText} needs a connection. Try again when you are online.` : e.message || failText, 'error', 5000);
    throw e;
  }
}

function list(ui, items, render) {
  return ui.h('ul', { class: 'books-list' }, items.map((x) => ui.h('li', null, render(x))));
}

// ---- closing date ------------------------------------------------------------------------------

function closingSection(body, ctx, redraw) {
  const { ui, auth, store } = ctx;
  const { h } = ui;
  const closing = store.settings().closing || {};
  const admin = auth.isAdmin?.() ?? ['owner', 'admin'].includes(auth.role());
  const head = h('div', { class: 'grid ops-stats books-stats' },
    ui.stat({ label: 'Books closed through', value: closing.booksThrough || 'Not closed', hint: closing.lockedBy ? `by ${closing.lockedBy}` : 'Records on or before it are read-only' }),
    ui.stat({ label: 'Payroll exported through', value: closing.payrollThrough || 'Nothing yet', hint: 'Hours are locked by run, not by date' }));
  body.append(head,
    h('p', { class: 'muted books-small' }, 'A closed record is changed by reversal, never edited: an invoice by a credit note, a payment by a reversal, a bill by a supplier credit, a stock move by an opposite move, hours by a correction. Records that arrive late (a phone syncing on the 2nd) are kept and posted on the first open day.'));
  if (!auth.synced) {
    body.append(offline(ui, 'Closing the books happens on your company’s server. In the demo nothing is locked. Sign in to your company to close a month.'));
    return;
  }
  const status = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  body.append(status);
  ctx.app.api.get('/api/v1/closing').then((s) => drawStatus(s)).catch((e) => {
    ui.clear(status).append(offline(ui, e.code === 'offline' ? 'You are offline. The closing date shown above is from the last sync; closing or reopening needs a connection.' : e.message));
  });

  function drawStatus(s) {
    const qb = s.quickbooks || {};
    const parts = [];
    if (qb.connected) {
      parts.push(h('div', { class: 'card books-qbo' },
        h('strong', null, 'QuickBooks'),
        h('p', { class: 'books-small' }, `Books closed through ${qb.bookCloseDate || 'not set'}, GST filed through ${qb.taxFiledThrough || 'not set'}, time locked through ${qb.timeLockedThrough || 'not set'}.`),
        s.booksBehindQuickBooks ? h('p', { class: 'books-warn' }, ui.icon('alert', 16), ` Fishtape's closing date is earlier than QuickBooks' (${qb.bookCloseDate}). Close Fishtape through the same day so both agree.`) : null));
    }
    if (admin) parts.push(closeForm(s));
    else parts.push(h('p', { class: 'muted books-small' }, 'Only an owner or admin closes the books (with two-step sign-in).'));
    parts.push(h('h2', { class: 'section' }, `Late postings (${s.latePostings?.count || 0})`),
      s.latePostings?.count ? list(ui, s.latePostings.items.slice(0, 50), (x) => {
        const rec = store.get(x.collection, x.id);
        return h('span', null, `${COLL_LABEL[x.collection] || x.collection} ${rec?.number || rec?.title || rec?.description || x.id.slice(0, 8)}`, h('span', { class: 'muted' }, ` posted ${x.postedOn}`));
      }) : h('p', { class: 'muted' }, 'Nothing arrived late for a closed period.'));
    parts.push(rejections(s));
    parts.push(h('h2', { class: 'section' }, 'History'),
      ui.table({
        columns: [
          { key: 'at', label: 'When', render: (r) => ui.fmtDateTime(r.at) },
          { key: 'kind', label: 'Lock', render: (r) => (r.kind === 'books' ? 'Books' : 'Payroll') },
          { key: 'through', label: 'Through', render: (r) => r.through || 'cleared' },
          { key: 'previous', label: 'Was', render: (r) => r.previous || '—' },
          { key: 'actor', label: 'By', render: (r) => String(r.actor || '').replace(/^[a-z]+:[^ ]* ?/, '') || '—' },
          { key: 'reason', label: 'Reason', render: (r) => r.reason || '' },
        ],
        rows: s.history || [], empty: h('p', { class: 'muted' }, 'The books have never been closed.'),
      }));
    ui.clear(status).append(...parts);
  }

  function closeForm(s) {
    const today = s.today || todayOf(store);
    const input = h('input', { class: 'input', type: 'date', name: 'through', value: endOfLastMonth(today), max: today, 'aria-label': 'Close through' });
    const reason = h('textarea', { class: 'input', name: 'reason', rows: 2, placeholder: 'Why (needed to move the date back, or to close with items still open)' });
    const checklist = h('div', { class: 'stack' });
    let checked = null;
    const check = async () => {
      checked = null;
      ui.clear(checklist).append(h('p', { class: 'muted' }, 'Checking…'));
      try {
        const pf = await serverCall(ctx, (api) => api.get(`/api/v1/closing/preflight?through=${encodeURIComponent(input.value)}`), 'The pre-close checklist');
        checked = pf;
        const open = Object.entries(pf.counts).filter(([, n]) => n > 0);
        ui.clear(checklist).append(open.length
          ? h('div', { class: 'books-preflight' }, h('p', { class: 'books-warn' }, ui.icon('alert', 16), ` ${pf.open} thing${pf.open === 1 ? ' is' : 's are'} still open for this period.`),
            ...open.map(([k, n]) => h('details', null, h('summary', null, `${PREFLIGHT_LABEL[k] || k}: ${n}`), list(ui, pf.lists[k] || [], (x) => `${x.label}${x.state ? ` (${x.state})` : ''}`))))
          : h('p', { class: 'books-ok' }, ui.icon('check', 16), ' Nothing is open for this period.'));
      } catch { ui.clear(checklist); }
    };
    const close = async (through) => {
      const back = s.books.through && (!through || through < s.books.through);
      if (back && !(await ui.confirmDialog(`Moving the closing date back to ${through || 'nothing'} reopens closed records. Payroll and returns you already filed may no longer match.`, { title: 'Reopen a closed period?', okLabel: 'Reopen' }))) return;
      try {
        await serverCall(ctx, (api) => api.put('/api/v1/closing/books', { through: through || null, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }), 'Closing the books');
        ui.toast(through ? `Books closed through ${through}` : 'Closing date cleared', 'success');
        await ctx.app.sync?.syncNow?.().catch(() => {});
        redraw();
      } catch (e) {
        if (e.code === 'preflight_open') ui.toast('Some things are still open. Check them, or say why you are closing anyway.', 'error', 5000);
      }
    };
    return h('div', { class: 'card books-close' },
      h('h2', { class: 'section' }, 'Close the books'),
      h('div', { class: 'row books-row' }, h('label', { class: 'field' }, h('span', null, 'Close through'), input),
        ui.button('Check what is open', { icon: 'list', onClick: check }),
        ui.button('Close', { variant: 'primary', icon: 'lock', onClick: () => close(input.value) })),
      checklist,
      h('label', { class: 'field' }, h('span', null, 'Reason'), reason),
      s.books.through ? h('div', { class: 'row' }, ui.button('Clear the closing date', { variant: 'ghost', icon: 'unlock', onClick: () => close(null) })) : null,
      h('p', { class: 'muted books-small' }, checked ? '' : 'Defaults to the end of last month. Check what is open first.'));
  }

  function rejections(s) {
    const box = h('div', { class: 'stack' }, h('h2', { class: 'section' }, `Refused writes (${s.rejections?.thisWeek || 0} this week)`));
    if (!['owner', 'admin', 'office'].includes(auth.role())) return box;
    const listBox = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    box.append(listBox);
    ctx.app.api.get('/api/v1/closing/rejections').then((r) => {
      const open = r.data.filter((x) => !x.resolvedAt);
      ui.clear(listBox).append(open.length ? ui.table({
        columns: [
          { key: 'at', label: 'When', render: (x) => ui.fmtDateTime(x.at) },
          { key: 'what', label: 'What', render: (x) => `${COLL_LABEL[x.collection] || x.collection} ${store.get(x.collection, x.recordId)?.number || x.recordId.slice(0, 12)}` },
          { key: 'who', label: 'Who', render: (x) => String(x.actor || '').replace(/^[a-z_]+:/, '').slice(0, 40) },
          { key: 'why', label: 'Why', render: (x) => h('span', null, x.message || x.code, REVERSAL_ACTION[x.collection] && x.code === 'period_locked' ? h('span', { class: 'muted' }, ` (${REVERSAL_ACTION[x.collection]} instead)`) : null) },
          { key: 'ok', label: '', render: (x) => ui.button('Mark resolved', { size: 'sm', onClick: async () => { await serverCall(ctx, (api) => api.post(`/api/v1/closing/rejections/${x.id}/resolve`, {}), 'Marking it resolved').catch(() => {}); redraw(); } }) },
        ],
        rows: open,
      }) : h('p', { class: 'muted' }, 'Nothing was refused.'));
    }).catch(() => ui.clear(listBox));
    return box;
  }
}

// ---- payroll -----------------------------------------------------------------------------------

function payrollSection(body, ctx, redraw) {
  const { ui, auth, store } = ctx;
  const { h } = ui;
  const runs = store.list('payrollRuns').sort((a, b) => String(b.to).localeCompare(String(a.to)));
  const late = lateHours(store);
  const people = new Map(store.list('employees').map((e) => [e.id, e]));
  const admin = ['owner', 'admin'].includes(auth.role());
  const pendingRuns = store.meta(PENDING_RUNS_META) || [];

  if (pendingRuns.length) {
    body.append(h('div', { class: 'card books-pending' },
      h('p', { class: 'books-warn' }, ui.icon('alert', 16), ` ${pendingRuns.length} payroll export${pendingRuns.length === 1 ? ' is' : 's are'} waiting to lock ${pendingRuns.length === 1 ? 'its' : 'their'} timesheets (made offline).`),
      ui.button('Lock them now', { variant: 'primary', icon: 'lock', onClick: () => retryPendingRuns(ctx).then(redraw) })));
  }

  body.append(h('h2', { class: 'section' }, 'Payroll runs'),
    ui.table({
      columns: [
        { key: 'period', label: 'Period', render: (r) => `${r.from} to ${r.to}` },
        { key: 'format', label: 'Format', render: (r) => r.format || '' },
        { key: 'entries', label: 'Entries', align: 'right', render: (r) => String((r.entryIds || []).length + (r.lateEntryIds || []).length) },
        { key: 'hours', label: 'Hours', align: 'right', render: (r) => fmtH(r.totals?.minutes || 0) },
        { key: 'when', label: 'Exported', render: (r) => `${ui.fmtDateTime(r.exportedAt)}${r.exportedBy?.name ? ` by ${r.exportedBy.name}` : ''}` },
        { key: 'status', label: 'Status', render: (r) => (r.status === 'reopened' ? h('span', { title: r.reopenReason || '' }, ui.badge('reopened', 'warning')) : ui.badge('locked', 'success')) },
        { key: 'act', label: '', render: (r) => (admin && r.status === 'exported' && auth.synced ? ui.button('Reopen', { size: 'sm', icon: 'unlock', onClick: () => reopen(r) }) : null) },
      ],
      rows: runs,
      empty: h('p', { class: 'muted' }, 'No payroll runs yet. Export payroll from Time clock → Timesheets; the export locks those timesheets.'),
    }));

  body.append(h('h2', { class: 'section' }, `Late hours (${late.length})`),
    h('p', { class: 'muted books-small' }, 'Hours worked on or before the last payroll export that were not in it (synced late, approved late, or left out). They stay editable and go in the next payroll export as prior-period rows.'),
    late.length ? ui.table({
      columns: [
        { key: 'who', label: 'Person', render: (e) => people.get(e.employeeId)?.name || 'Someone' },
        { key: 'day', label: 'Worked', render: (e) => entryDay(e) },
        { key: 'kind', label: 'Type', render: (e) => (isCorrection(e) ? ui.badge('correction', 'info') : e.approved ? ui.badge('approved', 'success') : ui.badge('not approved', 'warning')) },
        { key: 'hours', label: 'Hours', align: 'right', render: (e) => fmtH(entryMinutes(e)) },
        { key: 'job', label: 'Job', render: (e) => store.get('jobs', e.jobId)?.number || '—' },
      ],
      rows: late,
    }) : h('p', { class: 'muted' }, 'No late hours.'));

  // Vacation and holiday pay: each cheque (no accrual) or accrued (the month-end export accrues them).
  if (auth.can('invoices') || auth.can('settings')) {
    const pay = store.settings().payroll || {};
    const sel = (name, value) => h('select', { class: 'input', name, 'aria-label': name }, [['each-cheque', 'Paid on each cheque'], ['accrue', 'Accrued and paid later']].map(([v, l]) => h('option', { value: v, selected: (value || 'each-cheque') === v }, l)));
    const vac = sel('vacationPayMode', pay.vacationPayMode);
    const hol = sel('holidayPayMode', pay.holidayPayMode);
    body.append(h('h2', { class: 'section' }, 'Vacation and holiday pay'),
      h('div', { class: 'row books-row' }, h('label', { class: 'field' }, h('span', null, 'Vacation pay'), vac), h('label', { class: 'field' }, h('span', null, 'General holiday pay'), hol),
        ui.button('Save', { onClick: () => { store.saveSettings({ payroll: { ...(store.settings().payroll || {}), vacationPayMode: vac.value, holidayPayMode: hol.value } }); ui.toast('Saved', 'success'); } })));
  }

  async function reopen(run) {
    const reason = await ui.promptDialog(`Reopen payroll ${run.from} to ${run.to}? Its hours become editable again; correct the payroll provider by hand. Why?`, { title: 'Reopen a payroll run', okLabel: 'Reopen' });
    if (reason == null) return;
    if (reason.trim().length < 10) { ui.toast('Say why (at least 10 characters).', 'error'); return; }
    try {
      await serverCall(ctx, (api) => api.post(`/api/v1/closing/payroll-runs/${encodeURIComponent(run.id)}/reopen`, { reason: reason.trim() }), 'Reopening payroll');
      await ctx.app.sync?.syncNow?.().catch(() => {});
      ui.toast('Payroll run reopened', 'success');
      redraw();
    } catch { /* toast shown */ }
  }
}

/**
 * Payroll locks made offline: time.js keeps the request in store meta and Books sends it when back
 * online. Returns how many went through.
 */
export async function retryPendingRuns(ctx) {
  const { store, ui } = ctx;
  const left = [];
  let done = 0;
  for (const req of store.meta(PENDING_RUNS_META) || []) {
    try {
      await ctx.app.api.post('/api/v1/closing/payroll-runs', { ...req, leftOutAck: true });
      done++;
    } catch (e) {
      if (e.code === 'already_exported') { done++; continue; }
      left.push(req);
      if (e.code !== 'offline') ui.toast(e.message || 'A payroll lock was refused.', 'error', 5000);
    }
  }
  store.setMeta(PENDING_RUNS_META, left.length ? left : undefined);
  if (done) { await ctx.app.sync?.syncNow?.().catch(() => {}); ui.toast(`${done} payroll export${done === 1 ? '' : 's'} locked`, 'success'); }
  return done;
}

// ---- rules -------------------------------------------------------------------------------------

function rulesSection(body, ctx, redraw) {
  const { ui, auth, store } = ctx;
  const { h } = ui;
  const province = store.settings().company?.province || 'ON';
  const canEdit = auth.can('invoices');
  const box = h('div', { class: 'stack' });
  body.append(h('p', { class: 'muted books-small' }, 'Legal and statutory values Fishtape uses: prompt-payment days, holdback, tax timing, payroll maximums. A value marked "verify" never drives a deadline. A company value overrides Fishtape\'s and must name its source.'), box);
  if (!auth.synced) { box.append(offline(ui, 'The rules table loads when you\'re signed in.')); return; }
  const cached = store.meta(RULES_META);
  if (cached) drawRules(cached, true);
  else box.append(h('p', { class: 'muted' }, 'Loading…'));
  ctx.app.api.get(`/api/v1/rules/effective?province=${encodeURIComponent(province)}`)
    .then((r) => { store.setMeta(RULES_META, { ...r, fetchedAt: new Date().toISOString() }); drawRules(r, false); })
    .catch((e) => { if (!cached) ui.clear(box).append(offline(ui, e.code === 'offline' ? 'You are offline and the rules table has not loaded on this device yet.' : e.message)); });

  function drawRules(data, stale) {
    const company = store.list('rules');
    // Company records on this device win over the server's last answer for display (edits made offline).
    const resolved = resolveRules(data.rules.filter((r) => r.origin === 'platform'), company, { province, on: todayOf(store) });
    const rows = Object.entries(RULE_DEFS).filter(([, d]) => d.scope === 'all' || d.province === province).map(([key, def]) => ({ key, def, r: resolved.get(key) || null }));
    ui.clear(box).append(
      stale ? h('p', { class: 'muted books-small' }, `Shown from this device (loaded ${ui.fmtDateTime(data.fetchedAt)}).`) : null,
      ui.table({
        columns: [
          { key: 'label', label: 'Rule', render: (x) => h('div', null, h('strong', null, x.def.label), h('div', { class: 'muted books-small' }, x.def.kind === 'deadline' ? 'Drives an alarm or a countdown' : x.def.kind === 'rate' ? 'Used in a calculation' : 'A choice')) },
          { key: 'value', label: 'Value', render: (x) => ruleValueText(x.def, x.r?.value ?? null) },
          { key: 'status', label: 'Status', render: (x) => h('span', { class: 'row-inline' }, ui.badge(x.r?.status || 'verify', x.r?.status === 'verified' ? 'success' : x.r?.status === 'sourced' ? 'info' : 'warning'),
            x.r && x.r.status !== 'verified' ? h('span', { class: 'muted books-small' }, ' unconfirmed') : null,
            x.r?.staleOverride ? ui.badge('your value is older than Fishtape\'s', 'warning') : null,
            x.r?.missingYear ? ui.badge(`${x.r.missingYear} value not loaded`, 'danger') : null) },
          { key: 'source', label: 'Source', render: (x) => h('span', { class: 'books-small' }, x.r?.origin === 'company' ? 'Your company: ' : '', x.r?.source || '—') },
          { key: 'edit', label: '', render: (x) => (canEdit ? ui.button(x.r?.origin === 'company' ? 'Edit' : 'Override', { size: 'sm', onClick: () => editRule(x.key, x.def, x.r) }) : null) },
        ],
        rows,
      }));
  }

  function editRule(key, def, cur) {
    const own = cur?.origin === 'company' ? store.get('rules', cur.id) : null;
    const v = own?.value ?? cur?.value ?? null;
    const valueField = def.unit === 'bool'
      ? { label: 'Value', name: 'value', type: 'select', value: v == null ? '' : String(v), options: [{ value: '', label: 'Not set' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] }
      : def.unit === 'list' ? { label: 'Value (one per line)', name: 'value', type: 'textarea', value: Array.isArray(v) ? v.join('\n') : '', span: true }
        : { label: `Value (${def.unit})`, name: 'value', type: ['days', 'years', 'cents', 'pct', 'factor'].includes(def.unit) ? 'number' : def.unit === 'date' ? 'date' : 'text', step: 'any', value: v ?? '' };
    ui.formSheet({
      title: def.label,
      fields: [
        valueField,
        { label: 'In force from', name: 'effectiveFrom', type: 'date', value: own?.effectiveFrom || cur?.effectiveFrom || '' },
        { label: 'Status', name: 'status', type: 'select', value: own?.status || 'sourced', options: RULE_STATUS.map((s) => ({ value: s, label: s })) },
        { label: 'Source (who or what says so)', name: 'source', value: own?.source || '', required: true, span: true },
        { label: 'Link (https)', name: 'sourceUrl', value: own?.sourceUrl || '', span: true },
        { label: 'Confirmed by (name)', name: 'confirmedName', value: own?.confirmedBy?.name || '' },
        { label: 'Their role', name: 'confirmedRole', value: own?.confirmedBy?.role || '', hint: 'lawyer, accountant, owner…' },
        { label: 'Note', name: 'note', value: own?.note || '', span: true },
      ],
      danger: own ? { label: 'Remove our value', onClick: () => store.remove('rules', own.id) } : null,
      onSubmit(f) {
        let value = f.value;
        if (value === '' || value == null) value = null;
        else if (def.unit === 'bool') value = value === 'true';
        else if (def.unit === 'list') value = String(value).split('\n').map((x) => x.trim()).filter(Boolean);
        else if (['days', 'years', 'cents'].includes(def.unit)) value = Math.round(Number(value));
        else if (['pct', 'factor'].includes(def.unit)) value = Number(value);
        const rec = {
          key, province: def.scope === 'province' ? def.province : null, value, effectiveFrom: f.effectiveFrom || null, status: f.status, source: f.source.trim(),
          sourceUrl: f.sourceUrl.trim() || null, note: f.note.trim() || null,
          confirmedBy: f.confirmedName.trim() ? { name: f.confirmedName.trim(), role: f.confirmedRole.trim() || null } : null,
          confirmedAt: f.status === 'verified' ? (own?.confirmedAt || new Date().toISOString()) : null,
        };
        const bad = ruleProblem(def, value) || ruleRecordProblem(rec);
        if (bad) { ui.toast(bad, 'error', 4500); return false; }
        if (own) store.update('rules', own.id, rec); else store.add('rules', rec);
        ui.toast('Saved. It applies to your company from now on.', 'success');
        redraw();
      },
    });
  }
}

// ---- cost codes ----------------------------------------------------------------------------------

function costCodesSection(body, ctx, redraw) {
  const { ui, auth, store } = ctx;
  const { h } = ui;
  const all = store.list('costCodes').sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  const active = activeCostCodes(all);
  const canEdit = auth.can('estimates');
  const missing = missingStandardCodes(all);
  const requireOnTime = Boolean(store.settings().costCodes?.requireOnTime);

  body.append(
    h('p', { class: 'muted books-small' }, 'One short list of job phases, shared by estimates, invoices, time, bills, purchase orders, stock moves, material requests, field tickets and change orders. Reports group anything without a code as "Uncoded".'),
    h('div', { class: 'row books-row' },
      canEdit ? ui.button('Add a code', { variant: 'primary', icon: 'plus', onClick: () => edit(null) }) : null,
      canEdit && missing.length ? ui.button(`Add the standard codes (${missing.length})`, { icon: 'list', onClick: () => { for (const c of missing) store.add('costCodes', c); ui.toast('Standard codes added', 'success'); } }) : null,
      h('span', { class: 'grow' }),
      canEdit ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: requireOnTime, onChange: (e) => { store.saveSettings({ costCodes: { ...(store.settings().costCodes || {}), requireOnTime: e.target.checked } }); } }),
        h('span', null, 'Ask for a code at clock-in when the job has no phase set')) : null),
    ui.table({
      columns: [
        { key: 'code', label: 'Code', render: (c) => h('strong', null, c.code) },
        { key: 'name', label: 'Name', render: (c) => c.name },
        { key: 'group', label: 'Group', render: (c) => COST_CODE_GROUPS.find((g) => g.id === c.group)?.label || '—' },
        { key: 'bill', label: 'Billable', render: (c) => (c.billable === false ? ui.badge('not billable', 'warning') : 'yes') },
        { key: 'active', label: 'Status', render: (c) => (c.active === false ? ui.badge('inactive', 'neutral') : ui.badge('active', 'success')) },
      ],
      rows: all, onRowClick: canEdit ? edit : null,
      empty: ui.empty({ icon: 'list', title: 'No cost codes yet', text: `Start with the standard nine (${STANDARD_COST_CODES.map((c) => c.code).join(', ')}) or add your own.` }),
    }));

  // Each job's current phase: clock-ins and new tickets take it without asking.
  const jobs = store.list('jobs', (j) => ['scheduled', 'in-progress', 'on-hold'].includes(j.status)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
  if (active.length && jobs.length && auth.can('jobs') && auth.isManager()) {
    body.append(h('h2', { class: 'section' }, 'Current phase per job'),
      h('p', { class: 'muted books-small' }, 'The crew clock in to the job; the phase set here becomes the cost code of their time without asking.'),
      h('div', { class: 'books-phases' }, jobs.map((j) => h('label', { class: 'field books-phase' }, h('span', null, `${j.number} · ${j.title}`),
        h('select', { class: 'input', 'aria-label': `Phase for ${j.number}`, onChange: (e) => store.update('jobs', j.id, { currentCostCodeId: e.target.value || null }, { summary: 'job phase' }) },
          h('option', { value: '' }, 'No phase'), active.map((c) => h('option', { value: c.id, selected: c.id === j.currentCostCodeId }, costCodeLabel(c))))))));
  }

  function edit(cc) {
    ui.formSheet({
      title: cc ? `Cost code ${cc.code}` : 'New cost code',
      fields: [
        { label: 'Code', name: 'code', value: cc?.code || '', required: true, hint: 'Up to 20 characters, e.g. 150' },
        { label: 'Name', name: 'name', value: cc?.name || '', required: true },
        { label: 'Group', name: 'group', type: 'select', value: cc?.group || 'other', options: COST_CODE_GROUPS.map((g) => ({ value: g.id, label: g.label })) },
        { label: 'Order', name: 'order', type: 'number', value: cc?.order ?? (all.length + 1) },
        { label: 'Billable to the customer', name: 'billable', type: 'checkbox', value: cc ? cc.billable !== false : true },
        { label: 'Material on it is own use (warranty, callbacks)', name: 'ownUse', type: 'checkbox', value: Boolean(cc?.ownUse) },
        { label: 'Active', name: 'active', type: 'checkbox', value: cc ? cc.active !== false : true },
        { label: 'Note', name: 'note', value: cc?.note || '', span: true },
      ],
      onSubmit(f) {
        const rec = { code: f.code.trim(), name: f.name.trim(), group: f.group, order: f.order ?? 0, billable: f.billable, ownUse: f.ownUse ? (cc?.ownUse || 'warranty') : null, active: f.active, note: f.note.trim() || null };
        const bad = costCodeProblem({ ...rec, id: cc?.id }, all);
        if (bad) { ui.toast(bad, 'error'); return false; }
        if (cc) store.update('costCodes', cc.id, rec); else store.add('costCodes', rec);
        redraw();
      },
    });
  }
}
