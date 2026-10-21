// Schedule (S16): week board of crew x days, with job chips and weekly hour totals.
import { jobColor } from './jobs.js';

/** Monday of the week containing `day` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(day) {
  const d = new Date(day + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return localDay(d);
}
export function addDays(day, n) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDay(d);
}
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default {
  id: 'schedule',
  title: 'Schedule',
  icon: 'calendar',
  group: 'work',
  perm: 'schedule',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    const canEdit = auth.isManager();
    let start = weekStart(ctx.query.week || ui.today());
    let mobileDay = ui.today();
    const host = h('div');

    const activeJobs = () => store.list('jobs', (j) => !['complete', 'invoiced'].includes(j.status)).sort((a, b) => a.number.localeCompare(b.number));

    function assign(employeeId, date, entry) {
      if (!canEdit) return;
      const jobs = activeJobs();
      if (entry && !jobs.find((j) => j.id === entry.jobId)) { const j = store.get('jobs', entry.jobId); if (j) jobs.unshift(j); }
      if (!jobs.length) return ui.toast('Create an active job first', 'error');
      const people = store.list('employees', (e) => e.active !== false);
      ui.formSheet({
        title: entry ? 'Edit assignment' : 'Assign to job',
        submitLabel: entry ? 'Save' : 'Assign',
        fields: [
          { label: 'Job', name: 'jobId', type: 'select', value: entry?.jobId || '', required: true, span: true, options: jobs.map((j) => ({ value: j.id, label: `${j.number} · ${j.title}` })) },
          { label: 'Who', name: 'employeeId', type: 'select', value: entry?.employeeId || employeeId, options: people.map((p) => ({ value: p.id, label: p.name })) },
          { label: 'Date', name: 'date', type: 'date', value: entry?.date || date, required: true },
          { label: 'Hours', name: 'hours', type: 'number', step: '0.5', min: '0', max: '24', value: entry?.hours ?? 8, required: true },
          { label: 'Note', name: 'note', value: entry?.note || '', span: true },
        ],
        danger: entry ? { label: 'Remove', onClick: () => store.remove('schedule', entry.id) } : null,
        onSubmit(v) {
          const commit = (data) => {
            if (entry) store.update('schedule', entry.id, data);
            else {
              store.add('schedule', data);
              const job = store.get('jobs', data.jobId);
              if (job && !(job.crewIds || []).includes(data.employeeId)) store.update('jobs', job.id, { crewIds: [...(job.crewIds || []), data.employeeId] }, { silent: true });
            }
            ui.toast('Schedule updated', 'success');
          };
          // Past-due hold at dispatch (r1-get-paid.md 4.5): assigning a held client's job needs "Dispatch anyway".
          const held = heldClient(v.jobId);
          if (held && !(entry?.holdAck && entry.jobId === v.jobId)) {
            ui.confirmDialog(`${held.name} is on hold for a past-due account. Check with the office before sending a crew.`, { title: 'Past due: hold work', okLabel: 'Dispatch anyway', danger: true })
              .then((ok) => { if (ok) commit({ ...v, holdAck: { by: auth.who().name, at: new Date().toISOString() } }); });
            return;
          }
          commit(v);
        },
      });
    }

    /** The job's client when it is on a past-due or over-limit hold (no amounts: the flag only). */
    function heldClient(jobId) {
      const job = jobId ? store.get('jobs', jobId) : null;
      const client = job?.clientId ? store.get('clients', job.clientId) : null;
      return client?.credit?.hold?.on ? client : null;
    }

    function chip(s) {
      const job = store.get('jobs', s.jobId);
      return h('button', {
        type: 'button', class: 'ops-chip', style: { '--job': jobColor(s.jobId) }, title: `${job?.title || 'Job'}${s.note ? ' — ' + s.note : ''}`,
        onClick: (e) => { e.stopPropagation(); assign(s.employeeId, s.date, s); },
      }, h('span', { class: 'ops-chip-num' }, job?.number || '?'), heldClient(s.jobId) ? h('span', { class: 'ops-chip-hold', title: 'Past due: hold work' }, ui.icon('alert', 12)) : null,
      h('span', { class: 'ops-chip-title' }, job?.title || 'Deleted job'), h('span', { class: 'ops-chip-hrs' }, `${s.hours}h`));
    }

    const draw = () => {
      ui.clear(host);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      const end = days[6];
      const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
      const entries = store.list('schedule', (s) => s.date >= start && s.date <= end);
      const t = ui.today();

      const nav = h('div', { class: 'row ops-weeknav' },
        ui.button('', { icon: 'chevron-left', title: 'Previous week', onClick: () => { start = addDays(start, -7); draw(); } }),
        ui.button('This week', { onClick: () => { start = weekStart(ui.today()); mobileDay = ui.today(); draw(); } }),
        ui.button('', { icon: 'chevron-right', title: 'Next week', onClick: () => { start = addDays(start, 7); draw(); } }),
        h('strong', { class: 'ops-weeklabel' }, `${ui.fmtDate(start, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`));

      // desktop board
      const board = h('div', { class: 'ops-board', role: 'grid', 'aria-label': 'Crew schedule' },
        h('div', { class: 'ops-board-head', role: 'row' },
          h('div', { class: 'ops-board-corner' }, 'Crew'),
          days.map((d) => h('div', { class: ['ops-board-day', d === t ? 'today' : null], role: 'columnheader' },
            h('span', null, ui.fmtDate(d, { weekday: 'short' })), h('strong', null, ui.fmtDate(d, { day: 'numeric' })))),
          h('div', { class: 'ops-board-total' }, 'Week')),
        people.map((p) => {
          const mine = entries.filter((s) => s.employeeId === p.id);
          const total = mine.reduce((s, x) => s + (Number(x.hours) || 0), 0);
          return h('div', { class: 'ops-board-row', role: 'row' },
            h('div', { class: 'ops-board-person' }, h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)),
              h('div', null, h('div', { class: 'ops-person-name' }, p.name), h('div', { class: 'muted ops-small' }, p.role))),
            days.map((d) => {
              const cell = mine.filter((s) => s.date === d);
              const off = cell.length === 0;
              return h('div', {
                class: ['ops-cell', d === t ? 'today' : null, canEdit ? 'editable' : null], role: 'gridcell', tabindex: canEdit ? 0 : null,
                'aria-label': `${p.name} ${d}${off ? ' unassigned' : ''}`,
                onClick: () => assign(p.id, d), onKeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) assign(p.id, d); },
              }, cell.map(chip), off && canEdit ? h('span', { class: 'ops-cell-add' }, ui.icon('plus', 14)) : null);
            }),
            h('div', { class: ['ops-board-total', total > 40 ? 'over' : null] }, `${total}h`, total > 40 ? h('span', { class: 'ops-small' }, ' over 40') : null));
        }));

      // mobile day list
      if (mobileDay < start || mobileDay > end) mobileDay = start;
      const dayList = h('div', { class: 'ops-daylist' },
        ui.tabs(days.map((d) => ({ id: d, label: ui.fmtDate(d, { weekday: 'short', day: 'numeric' }) })), mobileDay, (d) => { mobileDay = d; draw(); }),
        h('div', { class: 'list', style: { marginTop: '12px' } }, people.map((p) => {
          const cell = entries.filter((s) => s.employeeId === p.id && s.date === mobileDay);
          return h('div', { class: 'list-row' },
            h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name),
              cell.length ? h('div', { class: 'ops-chips' }, cell.map(chip)) : h('div', { class: 'meta' }, 'Not scheduled')),
            canEdit ? ui.button('', { icon: 'plus', size: 'sm', title: `Assign ${p.name}`, onClick: () => assign(p.id, mobileDay) }) : null);
        })));

      host.append(ui.page({ title: 'Schedule', subtitle: 'Who is where this week', actions: [] }, nav,
        people.length ? [board, dayList] : ui.empty({ icon: 'users', title: 'No crew yet', text: 'Add employees to start scheduling.', action: ui.button('Employees', { href: '#/employees' }) })));
    };

    root.append(host);
    draw();
    const offs = ['schedule', 'employees', 'jobs', 'clients'].map((c) => store.on(c, draw));
    return () => offs.forEach((f) => f());
  },
};
