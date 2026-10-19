// Time clock (S21): clock in/out against a job, breaks, who's on the clock, weekly timesheets.
// An open break is tracked with `breakStart` on the entry; ending it adds to breakMins.
import { entryHours } from '../lib/money.js';
import { weekStart, addDays } from './schedule.js';

const pad = (n) => String(n).padStart(2, '0');
function clockText(hours) {
  const s = Math.max(0, Math.floor(hours * 3600));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
/** Hours net of breaks, including a break that is still running. */
function liveHours(e, now = new Date()) {
  const running = e.breakStart ? (now - new Date(e.breakStart)) / 3600000 : 0;
  return Math.max(0, entryHours(e, now) - running);
}
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default {
  id: 'time',
  title: 'Time clock',
  icon: 'clock',
  group: 'people',
  perm: 'time',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    const me = auth.current();
    const mgr = auth.isManager();
    const canApprove = auth.can('time-approve');
    let week = weekStart(ui.today());
    let who = me.id || store.list('employees')[0]?.id || null;
    const host = h('div');
    const timers = [];

    const openEntry = (empId) => store.list('timeEntries', (t) => t.employeeId === empId && !t.clockOut)[0] || null;
    const activeJobs = () => store.list('jobs', (j) => ['scheduled', 'in-progress', 'on-hold'].includes(j.status)).sort((a, b) => a.number.localeCompare(b.number));

    function clockPanel() {
      if (!me.id) return h('div', { class: 'card ops-clock' }, h('p', { class: 'muted' }, 'Pick who is using this device (avatar at the bottom of the rail) to clock in.'));
      const open = openEntry(me.id);
      const job = open && store.get('jobs', open.jobId);
      const readout = h('div', { class: 'ops-clock-time num', 'aria-live': 'off' }, open ? clockText(liveHours(open)) : '00:00:00');
      if (open) {
        const tick = setInterval(() => { readout.textContent = clockText(liveHours(store.get('timeEntries', open.id) || open)); }, 1000);
        timers.push(tick);
      }
      const jobSel = h('select', { class: 'input', 'aria-label': 'Job' },
        h('option', { value: '' }, 'No job (shop / admin)'),
        activeJobs().map((j) => h('option', { value: j.id, selected: (j.crewIds || []).includes(me.id) && !open }, `${j.number} · ${j.title}`)));
      const note = h('input', { class: 'input', placeholder: 'Note (optional)', value: open?.note || '', 'aria-label': 'Note' });

      const clockIn = () => {
        if (openEntry(me.id)) return;
        store.add('timeEntries', { employeeId: me.id, jobId: jobSel.value || null, clockIn: new Date().toISOString(), clockOut: null, breakMins: 0, breakStart: null, note: note.value, approved: false });
        ui.toast('Clocked in', 'success');
      };
      const clockOut = () => {
        const cur = store.get('timeEntries', open.id);
        let breakMins = Number(cur.breakMins) || 0;
        if (cur.breakStart) breakMins += Math.round((Date.now() - new Date(cur.breakStart)) / 60000);
        store.update('timeEntries', cur.id, { clockOut: new Date().toISOString(), breakMins, breakStart: null, note: note.value });
        ui.toast(`Clocked out · ${ui.fmtHours(entryHours({ ...cur, clockOut: new Date().toISOString(), breakMins }))}`, 'success');
      };
      const toggleBreak = () => {
        const cur = store.get('timeEntries', open.id);
        if (cur.breakStart) {
          const mins = Math.round((Date.now() - new Date(cur.breakStart)) / 60000);
          store.update('timeEntries', cur.id, { breakMins: (Number(cur.breakMins) || 0) + mins, breakStart: null }, { silent: true });
          ui.toast(`Break ended · ${mins} min`);
        } else {
          store.update('timeEntries', cur.id, { breakStart: new Date().toISOString() }, { silent: true });
          ui.toast('On break');
        }
      };

      return h('div', { class: ['card', 'ops-clock', open ? (open.breakStart ? 'on-break' : 'running') : null] },
        h('div', { class: 'ops-clock-face' },
          h('div', { class: 'ops-clock-ring' }, ui.icon('clock', 28)),
          h('div', null,
            h('div', { class: 'ops-clock-status' }, open ? (open.breakStart ? 'On break' : 'On the clock') : 'Off the clock',
              open ? h('span', { class: 'muted' }, ` since ${ui.fmtTime(open.clockIn)}`) : null),
            readout,
            open ? h('div', { class: 'muted' }, job ? `${job.number} · ${job.title}` : 'No job', open.breakMins ? ` · ${open.breakMins} min break` : '') : h('div', { class: 'muted' }, `Hi ${me.name.split(' ')[0]} — pick a job and clock in.`))),
        h('div', { class: 'ops-clock-controls' },
          open ? null : jobSel,
          note,
          open
            ? h('div', { class: 'row' },
              ui.button(open.breakStart ? 'End break' : 'Start break', { icon: open.breakStart ? 'play' : 'stop', size: 'lg', onClick: toggleBreak }),
              ui.button('Clock out', { variant: 'dark', icon: 'log-out', size: 'lg', onClick: clockOut }))
            : ui.button('Clock in', { variant: 'primary', icon: 'play', size: 'lg', onClick: clockIn })));
    }

    function whoIsOn() {
      const open = store.list('timeEntries', (t) => !t.clockOut);
      return [h('h2', { class: 'section' }, `Who's on the clock (${open.length})`),
        open.length ? h('div', { class: 'list' }, open.map((t) => {
          const p = store.get('employees', t.employeeId);
          const j = store.get('jobs', t.jobId);
          const span = h('span', { class: 'num' }, clockText(liveHours(t)));
          timers.push(setInterval(() => { span.textContent = clockText(liveHours(store.get('timeEntries', t.id) || t)); }, 1000));
          return h('div', { class: 'list-row' },
            h('span', { class: 'avatar', style: { background: p?.color || '#5f5a51' } }, ui.initials(p?.name)),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, p?.name || 'Unknown'), h('div', { class: 'meta' }, `${j ? j.number + ' · ' + j.title : 'No job'} · in at ${ui.fmtTime(t.clockIn)}`)),
            t.breakStart ? ui.badge('on break', 'warning') : null, span);
        })) : h('p', { class: 'muted' }, 'Nobody is clocked in.')];
    }

    function editEntry(entry) {
      const people = store.list('employees', (e) => e.active !== false || e.id === entry?.employeeId);
      const jobs = store.list('jobs');
      ui.formSheet({
        title: entry ? 'Edit time entry' : 'Add time entry',
        fields: [
          { label: 'Employee', name: 'employeeId', type: 'select', value: entry?.employeeId || who, options: people.map((p) => ({ value: p.id, label: p.name })) },
          { label: 'Job', name: 'jobId', type: 'select', value: entry?.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`, 'No job') },
          { label: 'Clock in', name: 'clockIn', type: 'datetime-local', value: toLocalInput(entry?.clockIn) || `${addDays(week, 0)}T07:00`, required: true },
          { label: 'Clock out', name: 'clockOut', type: 'datetime-local', value: toLocalInput(entry?.clockOut) || (entry ? '' : `${addDays(week, 0)}T15:30`), hint: 'Leave blank if still on the clock' },
          { label: 'Break (minutes)', name: 'breakMins', type: 'number', min: '0', value: entry?.breakMins ?? 30 },
          { label: 'Note', name: 'note', value: entry?.note || '', span: true },
        ],
        danger: entry ? { label: 'Delete', onClick: () => store.remove('timeEntries', entry.id) } : null,
        onSubmit(v) {
          const data = { ...v, jobId: v.jobId || null, breakMins: Number(v.breakMins) || 0, clockIn: new Date(v.clockIn).toISOString(), clockOut: v.clockOut ? new Date(v.clockOut).toISOString() : null };
          if (data.clockOut && data.clockOut <= data.clockIn) { ui.toast('Clock out must be after clock in', 'error'); return false; }
          if (!data.clockOut && openEntry(data.employeeId) && openEntry(data.employeeId).id !== entry?.id) { ui.toast('That person already has an open shift', 'error'); return false; }
          if (entry) store.update('timeEntries', entry.id, data); else store.add('timeEntries', { ...data, approved: false, breakStart: null });
          ui.toast('Time saved', 'success');
        },
      });
    }

    function timesheet() {
      const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
      if (!mgr) who = me.id;
      const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
      const end = days[6];
      const rows = store.list('timeEntries', (t) => t.employeeId === who && t.clockIn && ui.localDay(t.clockIn) >= week && ui.localDay(t.clockIn) <= end)
        .sort((a, b) => a.clockIn.localeCompare(b.clockIn));
      const byDay = Object.fromEntries(days.map((d) => [d, 0]));
      for (const t of rows) byDay[ui.localDay(t.clockIn)] += entryHours(t);
      const total = Object.values(byDay).reduce((a, b) => a + b, 0);
      const ot = Math.max(0, total - 40);
      const person = store.get('employees', who);

      const exportCsv = () => {
        const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        const lines = [['Employee', 'Date', 'Job', 'Clock in', 'Clock out', 'Break mins', 'Hours', 'Approved', 'Note'].join(',')];
        const scope = mgr ? store.list('timeEntries', (t) => t.clockIn && ui.localDay(t.clockIn) >= week && ui.localDay(t.clockIn) <= end) : rows;
        for (const t of scope.sort((a, b) => a.clockIn.localeCompare(b.clockIn))) {
          const j = store.get('jobs', t.jobId);
          lines.push([esc(store.get('employees', t.employeeId)?.name), ui.localDay(t.clockIn), esc(j ? `${j.number} ${j.title}` : ''), esc(ui.fmtTime(t.clockIn)), esc(t.clockOut ? ui.fmtTime(t.clockOut) : ''), t.breakMins || 0, entryHours(t).toFixed(2), t.approved ? 'yes' : 'no', esc(t.note)].join(','));
        }
        ui.download(`timesheet-${week}.csv`, lines.join('\n'), 'text/csv');
        store.log('export', `Timesheet CSV ${week}`, 'timeEntries');
      };

      return [
        h('h2', { class: 'section' }, 'Timesheet'),
        h('div', { class: 'row ops-toolbar' },
          ui.button('', { icon: 'chevron-left', title: 'Previous week', onClick: () => { week = addDays(week, -7); draw(); } }),
          h('strong', null, `${ui.fmtDate(week, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(end, { month: 'short', day: 'numeric' })}`),
          ui.button('', { icon: 'chevron-right', title: 'Next week', onClick: () => { week = addDays(week, 7); draw(); } }),
          mgr ? h('select', { class: 'input ops-who', 'aria-label': 'Employee', onChange: (e) => { who = e.target.value; draw(); } },
            people.map((p) => h('option', { value: p.id, selected: p.id === who }, p.name))) : null,
          h('span', { class: 'grow' }),
          mgr ? ui.button('Add entry', { icon: 'plus', onClick: () => editEntry(null) }) : null,
          ui.button('CSV', { icon: 'download', onClick: exportCsv, title: mgr ? 'Export everyone for this week' : 'Export my week' })),
        h('div', { class: 'ops-week' }, days.map((d) => h('div', { class: ['ops-week-day', d === ui.today() ? 'today' : null] },
          h('span', { class: 'muted ops-small' }, ui.fmtDate(d, { weekday: 'short', day: 'numeric' })), h('strong', { class: 'num' }, byDay[d] ? byDay[d].toFixed(2) : '—'))),
        h('div', { class: ['ops-week-day', 'total', ot > 0 ? 'over' : null] }, h('span', { class: 'muted ops-small' }, 'Total'), h('strong', { class: 'num' }, total.toFixed(2)),
          ot > 0 ? h('span', { class: 'ops-small' }, `${ot.toFixed(2)} OT`) : null)),
        ui.table({
          columns: [
            { key: 'day', label: 'Day', render: (t) => ui.fmtDate(t.clockIn, { weekday: 'short', month: 'short', day: 'numeric' }) },
            { key: 'job', label: 'Job', render: (t) => { const j = store.get('jobs', t.jobId); return j ? h('a', { href: '#/jobs/' + j.id, onClick: (e) => e.stopPropagation() }, j.number) : h('span', { class: 'muted' }, '—'); } },
            { key: 'in', label: 'In – out', render: (t) => `${ui.fmtTime(t.clockIn)} – ${t.clockOut ? ui.fmtTime(t.clockOut) : 'open'}` },
            { key: 'break', label: 'Break', align: 'right', render: (t) => `${t.breakMins || 0}m` },
            { key: 'hours', label: 'Hours', align: 'right', render: (t) => entryHours(t).toFixed(2) },
            { key: 'ok', label: 'Approved', render: (t) => (canApprove && t.clockOut
              ? h('input', { type: 'checkbox', checked: !!t.approved, 'aria-label': 'Approve entry', onClick: (e) => e.stopPropagation(),
                onChange: (e) => store.update('timeEntries', t.id, { approved: e.target.checked }, { summary: `${e.target.checked ? 'approved' : 'unapproved'} time ${ui.localDay(t.clockIn)} ${person?.name || ''}` }) })
              : t.approved ? ui.badge('approved', 'success') : ui.badge(t.clockOut ? 'pending' : 'open', t.clockOut ? 'warning' : 'info')) },
            { key: 'note', label: 'Note', render: (t) => t.note || '' },
          ],
          rows, onRowClick: mgr ? editEntry : null,
          empty: ui.empty({ icon: 'clock', title: 'No time this week', text: person ? `${person.name} has no entries for this week.` : 'Pick an employee.' }),
        }),
        canApprove && rows.some((t) => t.clockOut && !t.approved)
          ? h('div', { class: 'row', style: { marginTop: '12px' } }, ui.button('Approve whole week', { icon: 'check', onClick: () => {
            for (const t of rows) if (t.clockOut && !t.approved) store.update('timeEntries', t.id, { approved: true }, { silent: true });
            store.log('approve', `Approved week ${week} for ${person?.name}`, 'timeEntries');
            ui.toast('Week approved', 'success');
          } })) : null,
      ];
    }

    const draw = () => {
      timers.splice(0).forEach(clearInterval);
      ui.clear(host).append(ui.page({ title: 'Time clock', subtitle: ui.fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }) },
        clockPanel(), mgr ? whoIsOn() : null, timesheet()));
    };
    root.append(host);
    draw();
    const offs = ['timeEntries', 'jobs', 'employees'].map((c) => store.on(c, draw));
    return () => { offs.forEach((f) => f()); timers.splice(0).forEach(clearInterval); };
  },
};
