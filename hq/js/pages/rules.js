// Rules: the platform rows of the rules table (docs/releases/r1-get-paid.md 2.7). Legal and
// statutory values every company uses: prompt-payment day counts, holdback, payroll maximums, tax
// timing. HQ staff look; HQ admins change rows (audited). A company may override a row on its own
// Books > Rules screen. A value at "verify" never drives a deadline: no alarm runs on it.
import { del, get, put } from '../api.js';
import { ago } from '../fmt.js';
import { labelled } from '../kit.js';

const STATUS_TONE = { verified: 'success', sourced: 'info', verify: 'warning' };
const STATUS_TEXT = {
  verified: 'Verified: a lawyer, accountant or the official text confirmed it (who and when are recorded).',
  sourced: 'Sourced: a published source is cited, not yet confirmed for us.',
  verify: 'Verify: unconfirmed or missing. Deadlines never run on it; rates use their fallback and say so.',
};
const NUMBER_UNITS = new Set(['days', 'years', 'pct', 'cents', 'factor', 'hours']);

/** A value for display, by unit. */
function showValue(v, unit) {
  if (v === null || v === undefined) return 'not set';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty list)';
  if (unit === 'cents' && typeof v === 'number') return `$${(v / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === 'pct') return `${v}%`;
  if (unit === 'days') return `${v} day${v === 1 ? '' : 's'}`;
  if (unit === 'years') return `${v} year${v === 1 ? '' : 's'}`;
  return String(v);
}

/** The form control for a value, by unit, and how to read it back. */
function valueField(def, value) {
  const unit = def?.unit;
  if (unit === 'bool') {
    return { field: { label: 'Value', name: 'value', type: 'select', value: value === null || value === undefined ? '' : String(value), options: [{ value: '', label: '— not set —' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] }, read: (s) => (s === '' ? null : s === 'true') };
  }
  if (unit === 'list') {
    return { field: { label: 'Value (one per line)', name: 'value', type: 'textarea', rows: 6, value: Array.isArray(value) ? value.join('\n') : '', span: true }, read: (s) => { const a = String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); return a.length ? a : null; } };
  }
  if (NUMBER_UNITS.has(unit)) {
    return { field: { label: `Value (${unit === 'cents' ? 'in cents, e.g. 7130000 for $71,300.00' : unit})`, name: 'value', type: 'number', step: unit === 'pct' || unit === 'factor' ? 'any' : '1', value: value ?? '' }, read: (n) => (n === null || n === '' ? null : Number(n)) };
  }
  if (unit === 'date') return { field: { label: 'Value (a date)', name: 'value', type: 'date', value: value ?? '' }, read: (s) => (s ? s : null) };
  return { field: { label: 'Value', name: 'value', value: value ?? '' }, read: (s) => (s === '' ? null : s) };
}

/** A new dated row starts from the current one, but its confirmation does not carry over. */
function newDated(row, def, year) {
  return {
    ...row, effectiveFrom: def.yearly ? `${year + (row.effectiveFrom === `${year}-01-01` ? 1 : 0)}-01-01` : '',
    status: row.status === 'verified' ? 'sourced' : row.status, confirmedBy: null, confirmedAt: null,
  };
}

export default {
  render(root, { ui, isAdmin }) {
    const { h } = ui;
    let data = null;
    let filter = '';
    let statusFilter = '';
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(ui.page({
      title: 'Rules', subtitle: 'Legal and statutory values every company uses (platform rows; changes are audited)',
      actions: [ui.button('Refresh', { size: 'sm', onClick: () => load() })],
    }, body));

    function edit(def, key, row, { adding = false } = {}) {
      const vf = valueField(def, row?.value ?? null);
      const today = new Date().toISOString().slice(0, 10);
      ui.formSheet({
        title: adding ? `Add a dated row: ${def?.label || key}` : `${def?.label || key}`,
        wide: true,
        fields: [
          { label: 'Rule', name: 'key', value: key, readonly: true, span: true },
          { label: 'Province (empty = every province)', name: 'province', value: row?.province ?? def?.province ?? '', readonly: !adding || Boolean(def?.province), placeholder: 'MB' },
          { label: def?.yearly ? 'Effective from (1 January of its year)' : 'Effective from', name: 'effectiveFrom', type: 'date', value: row?.effectiveFrom ?? (def?.yearly ? `${new Date().getFullYear()}-01-01` : today), readonly: !adding, required: true },
          vf.field,
          { label: 'Status', name: 'status', type: 'select', value: row?.status ?? 'verify', options: (data.statuses || ['verified', 'sourced', 'verify']).map((s) => ({ value: s, label: s })), required: true },
          { label: 'Source (who or what says so)', name: 'source', value: row?.source ?? '', span: true },
          { label: 'Source link (https)', name: 'sourceUrl', value: row?.sourceUrl ?? '', span: true, placeholder: 'https://…' },
          { label: 'Confirmed by (name and role; for verified)', name: 'confirmedBy', value: row?.confirmedBy ?? '' },
          { label: 'Confirmed on (for verified)', name: 'confirmedAt', type: 'date', value: row?.confirmedAt ? row.confirmedAt.slice(0, 10) : '', max: today },
          { label: 'Note', name: 'note', type: 'textarea', rows: 3, value: row?.note ?? '', span: true },
        ],
        extra: h('div', { class: 'stack', style: { gap: '4px' } },
          def?.description ? h('p', { class: 'muted hq-small' }, def.description) : null,
          def?.usedBy?.length ? h('p', { class: 'muted hq-small' }, `Used by: ${def.usedBy.join(', ')}.`) : null,
          h('p', { class: 'muted hq-small' }, STATUS_TEXT.verified), h('p', { class: 'muted hq-small' }, STATUS_TEXT.verify)),
        submitLabel: adding ? 'Add' : 'Save',
        onSubmit: (v) => {
          let value;
          try { value = vf.read(v.value); } catch { ui.toast('Check the value', 'error'); return false; }
          if (typeof value === 'number' && !Number.isFinite(value)) { ui.toast('Check the value', 'error'); return false; }
          if (v.status === 'verified' && (!v.confirmedBy.trim() || !v.confirmedAt)) { ui.toast('Verified needs who confirmed it and when', 'error'); return false; }
          put('/api/hq/rules', {
            key, province: v.province || '', effectiveFrom: v.effectiveFrom, value, status: v.status,
            source: v.source || null, sourceUrl: v.sourceUrl || null, note: v.note || null,
            confirmedBy: v.confirmedBy || null, confirmedAt: v.confirmedAt || null,
          }).then(() => { ui.toast('Saved', 'success'); load(); }, (e) => {
            const errs = e.details?.errors;
            ui.toast(errs && !Array.isArray(errs) ? Object.entries(errs).map(([f, m]) => `${f}: ${m}`).join(' ') : e.message, 'error');
          });
        },
        danger: !adding && row && isAdmin ? {
          label: 'Remove this row',
          onClick: async () => {
            if (!(await ui.confirmDialog(`Remove ${key}${row.province ? ` (${row.province})` : ''} from ${row.effectiveFrom}? Companies then fall back to an older row, or to "not set".`, { okLabel: 'Remove' }))) return;
            const q = new URLSearchParams({ key, province: row.province || '', effectiveFrom: row.effectiveFrom });
            del(`/api/hq/rules?${q}`).then(() => { ui.toast('Removed', 'success'); load(); }, (e) => ui.toast(e.message, 'error'));
          },
        } : null,
      });
    }

    function draw() {
      ui.clear(body);
      const { defs, rows, gaps } = data;
      const year = new Date().getFullYear();
      if (gaps.length) {
        body.append(h('div', { class: ['hq-banner', 'degraded'] }, ui.icon('alert', 20), h('div', null,
          h('strong', null, `${gaps.length} rule${gaps.length === 1 ? '' : 's'} to look at`),
          h('ul', null, gaps.slice(0, 12).map((g) => h('li', null, h('span', { class: 'mono' }, g.key), ` ${defs[g.key]?.label ? `(${defs[g.key].label})` : ''}: ${g.text}`))),
          gaps.length > 12 ? h('span', { class: 'hq-small' }, `and ${gaps.length - 12} more below`) : null)));
      }
      body.append(h('div', { class: 'hq-legend' }, ['verified', 'sourced', 'verify'].map((s) => h('span', { title: STATUS_TEXT[s] }, ui.badge(s, STATUS_TONE[s]), ` ${STATUS_TEXT[s].split(':')[1].split('.')[0].trim()}`))));

      const toolbar = h('div', { class: 'hq-toolbar' },
        ui.searchBox('Search rules', (q) => { filter = q.toLowerCase(); drawTable(); }, filter),
        labelled(ui, 'Status', h('select', { 'aria-label': 'Status', onChange: (e) => { statusFilter = e.target.value; drawTable(); } },
          [['', 'Every status'], ['verified', 'Verified'], ['sourced', 'Sourced'], ['verify', 'Verify']].map(([v, l]) => h('option', { value: v, selected: v === statusFilter }, l)))));
      const tableHost = h('div');
      body.append(toolbar, tableHost);

      function drawTable() {
        ui.clear(tableHost);
        const items = [];
        for (const [key, def] of Object.entries(defs)) {
          if (def.scope === 'company' || key.startsWith('payroll.company.')) continue;
          const mine = rows.filter((r) => r.key === key).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
          if (!mine.length) items.push({ key, def, row: null });
          for (const row of mine) items.push({ key, def, row });
        }
        // Rows HQ holds for keys the code no longer defines (shown so they can be removed).
        for (const row of rows) if (!defs[row.key]) items.push({ key: row.key, def: null, row });
        const shown = items.filter((x) => (!statusFilter || (x.row?.status || 'verify') === statusFilter)
          && (!filter || `${x.key} ${x.def?.label || ''} ${x.row?.source || ''}`.toLowerCase().includes(filter)));
        tableHost.append(ui.table({
          columns: [
            { key: 'rule', label: 'Rule', render: (x) => h('div', null, h('strong', null, x.def?.label || x.key), h('div', { class: 'mono hq-small muted' }, x.key),
              x.def ? null : ui.badge('not defined in code', 'danger')) },
            { key: 'prov', label: 'Province', render: (x) => x.row?.province || x.def?.province || 'All' },
            { key: 'from', label: 'From', render: (x) => (x.row ? (x.row.effectiveFrom === '1900-01-01' ? 'always' : x.row.effectiveFrom) : '—') },
            { key: 'value', label: 'Value', render: (x) => (x.row ? showValue(x.row.value, x.def?.unit) : h('span', { class: 'muted' }, 'no row')) },
            { key: 'status', label: 'Status', render: (x) => (x.row ? ui.badge(x.row.status, STATUS_TONE[x.row.status] || 'neutral') : ui.badge('verify', 'warning')) },
            { key: 'source', label: 'Source', render: (x) => (x.row?.sourceUrl
              ? h('a', { href: x.row.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, x.row.source || 'link')
              : x.row?.source || '—') },
            { key: 'confirmed', label: 'Confirmed', render: (x) => (x.row?.confirmedBy ? `${x.row.confirmedBy}, ${ui.fmtDate(x.row.confirmedAt)}` : '—') },
            { key: 'changed', label: 'Changed', render: (x) => (x.row?.updatedAt ? h('span', { title: x.row.updatedBy || '' }, ago(x.row.updatedAt)) : '—') },
            { key: 'act', label: '', render: (x) => (isAdmin ? h('div', { class: 'row' },
              x.row ? ui.button('Edit', { size: 'sm', variant: 'ghost', onClick: () => edit(x.def, x.key, x.row) }) : null,
              x.def ? ui.button(x.row ? 'Add dated row' : 'Add', { size: 'sm', variant: 'ghost', onClick: () => edit(x.def, x.key, x.row ? newDated(x.row, x.def, year) : null, { adding: true }) }) : null) : null) },
          ],
          rows: shown,
          empty: h('div', { class: 'card flat muted' }, 'No rules match.'),
        }));
        if (!isAdmin) tableHost.append(h('p', { class: 'muted hq-small' }, 'HQ admins change rules.'));
      }
      drawTable();
    }

    async function load() {
      try {
        data = await get('/api/hq/rules');
        draw();
      } catch (e) {
        ui.clear(body);
        body.append(ui.empty({ icon: 'alert', title: 'Could not load the rules', text: e.message, action: ui.button('Try again', { onClick: () => load() }) }));
      }
    }

    load();
    return () => {};
  },
};
