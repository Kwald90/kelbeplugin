// Labour levels & apprentice hours (#/labour). Crew levels each carry a cost rate, a charge rate
// and a PRODUCTIVITY factor, so the same work takes a 1st-year apprentice longer than a journeyman
// and costs a different amount. Three tabs:
//   Levels      — edit the rate/productivity table and pick the baseline (what assembly hours mean)
//   Assembly    — see any assembly's time, cost, charge and margin for every level
//   Apprentices — give each person a level, then roll real timesheet hours up by level + the ratio
// Pure logic: js/lib/labour-levels.js. Office-only (perm 'employees'): it shows pay rates.
import {
  levelsOf, activeLevels, normalizeLevels, newLevel, baselineLevel, LEVEL_KINDS,
  labourByLevel, apprenticeHours,
} from '../lib/labour-levels.js';
import { labourUnitHours } from '../lib/assemblies.js';
import { moneyFormatter } from '../lib/money.js';
import { entryMinutes, localDay, addDays } from '../lib/timesheet.js';

const KIND_LABEL = { apprentice: 'Apprentice', journeyman: 'Journeyman', foreman: 'Foreman', other: 'Other' };
const dollars = (cents) => (Math.round(cents || 0) / 100).toFixed(2);
const toCents = (v) => Math.round((Number(v) || 0) * 100);

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/labour.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/labour.css';
  document.head.append(link);
}

export default {
  id: 'labour',
  title: 'Labour & rates',
  icon: 'users',
  group: 'people',
  perm: 'employees',
  render(root, ctx) {
    loadCss();
    const { store, ui } = ctx;
    const { h } = ui;
    const tabs = [
      { id: 'levels', label: 'Levels' },
      { id: 'assembly', label: 'Assembly times' },
      { id: 'apprentices', label: 'Apprentice hours' },
    ];
    let tab = (ctx.query.tab && tabs.some((t) => t.id === ctx.query.tab)) ? ctx.query.tab : 'levels';
    const body = h('div', { class: 'stack' });

    const draw = () => {
      ui.clear(body);
      if (tab === 'levels') drawLevels(body, ctx);
      else if (tab === 'assembly') drawAssembly(body, ctx);
      else drawApprentices(body, ctx);
    };

    root.append(ui.page(
      { title: 'Labour & rates', subtitle: 'Crew levels, rates and productivity — and apprentice hours by level' },
      ui.tabs(tabs, tab, (id) => { tab = id; history.replaceState(null, '', `#/labour?tab=${id}`); draw(); }),
      body,
    ));
    draw();
    return store.on('settings', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  },
};

// ---------- levels ----------
function drawLevels(host, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const levels = levelsOf(store.settings());
  const base = baselineLevel(store.settings());

  const saveLevels = (list, extra = {}) => store.saveSettings({ labourLevels: normalizeLevels(list), ...extra });

  const editLevel = (lvl) => {
    const isNew = !lvl;
    const l = lvl || newLevel();
    ui.formSheet({
      title: isNew ? 'Add a level' : 'Edit level',
      fields: [
        { label: 'Name', name: 'name', value: l.name, required: true, span: true },
        { label: 'Kind', name: 'kind', type: 'select', value: l.kind, options: LEVEL_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })) },
        { label: 'Apprentice year', name: 'year', type: 'select', value: l.year == null ? '' : String(l.year), options: [{ value: '', label: '—' }, ...[1, 2, 3, 4].map((y) => ({ value: String(y), label: `${y}` }))], hint: 'For apprentices only.' },
        { label: 'Productivity %', name: 'productivityPct', type: 'number', value: l.productivityPct, required: true, hint: 'Journeyman = 100. Lower = slower, so it takes more hours.' },
        { label: 'Cost $/hr', name: 'cost', type: 'number', value: dollars(l.costCents), hint: 'What this level costs you.' },
        { label: 'Charge $/hr', name: 'charge', type: 'number', value: dollars(l.chargeCents), hint: 'What you bill for this level.' },
      ],
      submitLabel: isNew ? 'Add' : 'Save',
      onSubmit: (v) => {
        if (!String(v.name || '').trim()) { ui.toast('Name the level', 'error'); return false; }
        const rec = { ...l, name: v.name.trim(), kind: v.kind, year: v.year ? Number(v.year) : null, productivityPct: Number(v.productivityPct) || 100, costCents: toCents(v.cost), chargeCents: toCents(v.charge) };
        const list = isNew ? [...levels, rec] : levels.map((x) => (x.id === l.id ? rec : x));
        saveLevels(list);
        ui.toast(isNew ? 'Level added' : 'Saved', 'success', 1200);
        drawLevels(host, ctx);
      },
    });
  };

  const archiveLevel = async (l) => {
    if (!(await ui.confirmDialog(`${l.archived ? 'Restore' : 'Archive'} "${l.name}"?`, { okLabel: l.archived ? 'Restore' : 'Archive' }))) return;
    saveLevels(levels.map((x) => (x.id === l.id ? { ...x, archived: !x.archived } : x)));
    drawLevels(host, ctx);
  };

  ui.clear(host);
  host.append(
    h('div', { class: 'row wt-toolbar' },
      h('div', { class: 'hint' }, 'Set what each level costs, what you bill, and how fast they work. ', h('strong', null, 'Productivity'), ' is relative to a journeyman at 100% — a slower level takes proportionally more hours on the same job.'),
      h('span', { class: 'grow' }),
      ui.button('Add level', { variant: 'primary', icon: 'plus', onClick: () => editLevel(null) })),
    ui.table({
      columns: [
        { key: 'name', label: 'Level', render: (l) => h('span', null, l.name, l.archived ? ' ' : '', l.archived ? ui.badge('archived', 'default') : (base && l.id === base.id ? ui.badge('baseline', 'info') : '')) },
        { key: 'kind', label: 'Kind', render: (l) => KIND_LABEL[l.kind] || l.kind },
        { key: 'prod', label: 'Productivity', align: 'right', render: (l) => `${l.productivityPct}%` },
        { key: 'cost', label: 'Cost /hr', align: 'right', render: (l) => money(l.costCents) },
        { key: 'charge', label: 'Charge /hr', align: 'right', render: (l) => money(l.chargeCents) },
        { key: 'act', label: '', align: 'right', render: (l) => h('div', { class: 'row' },
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'pen', title: 'Edit', onClick: () => editLevel(l) }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: l.archived ? 'Restore' : 'Archive', onClick: () => archiveLevel(l) })) },
      ],
      rows: levels,
    }),
    h('div', { class: 'row lv-baseline' },
      h('label', { class: 'hint' }, 'Assembly hours are quoted at: '),
      (() => {
        const sel = h('select', { class: 'input', 'aria-label': 'Baseline level', onChange: (e) => { saveLevels(levels, { baselineLevelId: e.target.value }); ui.toast('Baseline set', 'success', 1000); drawLevels(host, ctx); } },
          activeLevels(store.settings()).map((l) => h('option', { value: l.id, selected: base && l.id === base.id }, `${l.name} (${l.productivityPct}%)`)));
        return sel;
      })()),
  );
}

// ---------- assembly times by level ----------
function drawAssembly(host, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const assemblies = store.list('assemblies').filter((a) => !a.archived);
  let baseHours = assemblies[0] ? labourUnitHours(assemblies[0]) : 1;
  let picked = assemblies[0]?.id || '';

  const out = h('div', { class: 'stack' });
  const render = () => {
    ui.clear(out);
    const rows = labourByLevel(baseHours, store.settings());
    out.append(
      h('div', { class: 'hint' }, `At ${baseHours || 0} journeyman hour${baseHours === 1 ? '' : 's'}, here is the time and money for each level:`),
      ui.table({
        columns: [
          { key: 'level', label: 'Level', render: (r) => r.level.name },
          { key: 'hours', label: 'Hours', align: 'right', render: (r) => r.hours.toFixed(2) },
          { key: 'cost', label: 'Labour cost', align: 'right', render: (r) => money(r.costCents) },
          { key: 'charge', label: 'Labour charge', align: 'right', render: (r) => money(r.chargeCents) },
          { key: 'margin', label: 'Margin', align: 'right', render: (r) => money(r.marginCents) },
        ],
        rows,
      }),
      h('div', { class: 'hint' }, 'Lower levels take more hours (productivity), so the labour cost and the margin shift with who you put on the work.'),
    );
  };

  ui.clear(host);
  const hoursInput = h('input', { class: 'input lv-hours', type: 'number', min: '0', step: '0.25', value: String(baseHours), 'aria-label': 'Journeyman hours' });
  hoursInput.addEventListener('input', () => { baseHours = Math.max(0, Number(hoursInput.value) || 0); render(); });
  const pick = h('select', { class: 'input', 'aria-label': 'Assembly', onChange: (e) => {
    picked = e.target.value;
    const a = assemblies.find((x) => x.id === picked);
    if (a) { baseHours = labourUnitHours(a); hoursInput.value = String(baseHours); }
    render();
  } }, h('option', { value: '' }, '— type hours —'), assemblies.map((a) => h('option', { value: a.id, selected: a.id === picked }, `${a.name} (${labourUnitHours(a)} h)`)));

  host.append(
    h('div', { class: 'row wt-toolbar' },
      h('label', { class: 'hint' }, 'Assembly'), pick,
      h('label', { class: 'hint' }, 'or journeyman hours'), hoursInput),
    assemblies.length ? null : h('div', { class: 'hint' }, 'No assemblies yet — type a number of journeyman hours to see how it splits by level.'),
    out,
  );
  render();
}

// ---------- apprentice hours ----------
/**
 * One row per PERSON. A shop often has more than one employee record for the same human — the
 * account makes an auto employee (owner/admin) when a timecard is set up, and the field crew get
 * added by hand too — so records that share a name (case-insensitive) are folded into one person.
 * Every underlying id is kept, so the level is set on all of them and hours logged under any of them
 * roll up together.
 */
export function peopleFromEmployees(employees) {
  const groups = new Map();
  for (const e of employees) {
    const key = (e.name || '').trim().toLowerCase() || `id:${e.id}`;
    let g = groups.get(key);
    if (!g) { g = { ids: [], name: e.name || 'Crew', roles: [], levelId: null }; groups.set(key, g); }
    g.ids.push(e.id);
    if (e.role && !g.roles.includes(e.role)) g.roles.push(e.role);
    if (e.labourLevelId && !g.levelId) g.levelId = e.labourLevelId; // first set level wins
    if ((e.name || '').length > g.name.length) g.name = e.name; // prefer the fuller name
  }
  return [...groups.values()].map((g) => ({ ...g, role: g.roles.join(' · ') }));
}

function drawApprentices(host, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const levels = activeLevels(store.settings());
  const people = peopleFromEmployees(store.list('employees').filter((e) => e.active !== false));
  // employee id -> the person's level, rebuilt from the people whenever a level changes
  const employeeLevel = {};
  const mapLevels = () => { for (const k of Object.keys(employeeLevel)) delete employeeLevel[k]; for (const p of people) if (p.levelId) for (const id of p.ids) employeeLevel[id] = p.levelId; };
  mapLevels();

  // default range: the last 14 days
  let to = ctx.ui.today();
  let from = addDays(to, -13);

  // Persist on all of the person's records, then refresh ONLY the summary — never rebuild the
  // table, so the native <select> the user just tapped keeps its value (iOS commits it cleanly).
  const setLevel = (person, levelId) => {
    const v = levelId || null;
    for (const id of person.ids) store.update('employees', id, { labourLevelId: v });
    person.levelId = v;
    mapLevels();
    render();
  };

  const out = h('div', { class: 'stack' });
  const render = () => {
    ui.clear(out);
    const entries = store.list('timeEntries')
      .filter((e) => e.kind !== 'correction' && e.employeeId)
      .map((e) => ({ employeeId: e.employeeId, minutes: entryMinutes(e), day: e.clockIn ? localDay(e.clockIn) : null }))
      .filter((e) => e.minutes > 0 && e.day && e.day >= from && e.day <= to);
    const roll = apprenticeHours(entries, { employeeLevel, settings: store.settings() });
    out.append(
      h('div', { class: 'lv-stats' },
        h('div', { class: 'lv-stat' }, h('b', null, roll.totalHours.toFixed(1)), h('span', null, 'total hours')),
        h('div', { class: 'lv-stat' }, h('b', null, roll.apprenticeHours.toFixed(1)), h('span', null, 'apprentice hours')),
        h('div', { class: 'lv-stat' }, h('b', null, roll.journeymanHours.toFixed(1)), h('span', null, 'journeyman + foreman')),
        h('div', { class: 'lv-stat' }, h('b', null, roll.ratio == null ? '—' : `${roll.ratio.toFixed(2)}:1`), h('span', null, 'apprentice : journeyman'))),
      roll.rows.length ? ui.table({
        columns: [
          { key: 'level', label: 'Level', render: (r) => (r.level ? r.level.name : h('span', { class: 'muted' }, 'Unassigned')) },
          { key: 'hours', label: 'Hours', align: 'right', render: (r) => r.hours.toFixed(1) },
          { key: 'cost', label: 'Labour cost', align: 'right', render: (r) => (r.level ? money(r.costCents) : '—') },
        ],
        rows: roll.rows,
      }) : ui.empty({ icon: 'clock', title: 'No hours in this range', text: 'Pick a wider range, or clock some time against jobs.' }),
    );
  };

  ui.clear(host);
  const fromI = h('input', { class: 'input', type: 'date', value: from, 'aria-label': 'From' });
  const toI = h('input', { class: 'input', type: 'date', value: to, 'aria-label': 'To' });
  fromI.addEventListener('change', () => { from = fromI.value; render(); });
  toI.addEventListener('change', () => { to = toI.value; render(); });

  host.append(
    h('div', { class: 'hint' }, 'Give each person a level, then see their hours rolled up by level. The ratio is apprentice hours per journeyman hour.'),
    levels.length ? null : h('div', { class: 'hint' }, 'Add some levels on the Levels tab first.'),
    ui.table({
      columns: [
        { key: 'name', label: 'Person', render: (p) => p.name || 'Crew' },
        { key: 'role', label: 'Role', render: (p) => p.role || '' },
        { key: 'level', label: 'Labour level', render: (p) => {
          const sel = h('select', { class: 'input lv-level-select', 'aria-label': `Level for ${p.name || 'crew'}` },
            h('option', { value: '', selected: !p.levelId }, '—'),
            levels.map((l) => h('option', { value: l.id, selected: p.levelId === l.id }, l.name)));
          sel.addEventListener('change', (ev) => setLevel(p, ev.target.value));
          return sel;
        } },
      ],
      rows: people,
    }),
    h('div', { class: 'row wt-toolbar' }, h('label', { class: 'hint' }, 'From'), fromI, h('label', { class: 'hint' }, 'To'), toI),
    out,
  );
  render();
}
