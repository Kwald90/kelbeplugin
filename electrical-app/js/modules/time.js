// Time clock (S21): clock in and out against a job, travel between jobs, breaks, who's on the
// clock, weekly timesheets with overtime by province, one-tap approval and payroll exports.
// With the worker's consent, one location fix is taken at each clock change (only while clocked
// in) to suggest the job, flag off-site clock-ins and notice travel (lib/shift-tracker.js).
// Routes: #/time (clock), #/time/week (timesheets), #/time/location (my location),
// #/time/settings (owner: location policy and payroll), #/time/map (opt-in live crew map).
//
// Release 1 (docs/releases/r1-get-paid.md 2.6, 2.8, 8.2): the open shift shows its cost code (the
// job's phase) and truck, set at clock-in without asking, with a "Change" link; managers recode a
// week's entries in approval; entries in an exported payroll run (or a closed period) are read-only
// and changed by a correction entry; exporting payroll offers "Lock these timesheets" (on by
// default), includes late hours and corrections from earlier periods, and lists what the run leaves
// out. The lock is a server call; made offline it waits on Books → Payroll.
import { addDays } from './schedule.js';
import { openEntry, reviewFlag, approveEntries, costCodeFor } from '../lib/clock.js';
import { qboBadge } from '../lib/qbo-ui.js';
import { weekSheet, weekOf, otRule, ruleText, fmtH, entryMinutes, kindOf, PAYROLL_FORMATS, payrollCsv, fillWagepointTemplate, isCorrection, entryDay } from '../lib/timesheet.js';
import { locksFrom, isLocked, zoneFor, isLateHours } from '../lib/closing.js';
import { activeCostCodes, costCodeLabel } from '../lib/cost-codes.js';
import { PENDING_RUNS_META } from './books.js';
import { locationSettings, locationState } from '../lib/location-policy.js';
import { fmtDistance } from '../lib/geo.js';
import { myLocation, settingsForm, crewMap } from '../lib/location-ui.js';
import { parseCSV, toCSV } from '../lib/csv.js';
import * as tracker from '../lib/shift-tracker.js';

const pad = (n) => String(n).padStart(2, '0');
function clockText(min) {
  const s = Math.max(0, Math.floor(min * 60));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
/** Minutes so far, net of breaks, a running break included. */
const liveMin = (e) => {
  if (!e?.clockIn) return 0;
  const run = e.breakStart ? (Date.now() - Date.parse(e.breakStart)) / 60000 : 0;
  return Math.max(0, (Date.now() - Date.parse(e.clockIn)) / 60000 - (Number(e.breakMins) || 0) - run);
};
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Payroll settings with defaults: overtime rule key, week start, export format. */
export function payrollPrefs(settings) {
  const p = settings?.payroll || {};
  return { otRule: p.otRule || settings?.company?.province || 'ON', weekStartsOn: Number.isInteger(p.weekStartsOn) ? p.weekStartsOn : 1, format: p.format || 'wagepoint' };
}

/** Location words for an entry: "at the site", "4.2 km from the job site", "no location". */
function locBadge(ui, e) {
  if (e.flag && !e.flag.reviewedAt) return ui.badge(e.flag.text || 'off site', 'danger');
  if (e.flag?.reviewedAt) return ui.badge(`${e.flag.text} · reviewed`, 'neutral');
  if (e.siteCheck?.inside) return ui.badge('at the site', 'success');
  if (e.siteCheck && Number.isFinite(e.siteCheck.distanceM)) return ui.badge(`${fmtDistance(e.siteCheck.distanceM)} away`, 'warning');
  if (e.locStatus && !['captured', 'pending'].includes(e.locStatus)) return ui.h('span', { class: 'muted loc-small' }, e.locStatus === 'declined' || e.locStatus === 'off' ? 'no location' : `no fix (${e.locStatus})`);
  return null;
}

const kindBadge = (ui, e) => (kindOf(e) === 'travel' ? ui.badge('travel', 'info') : ui.badge('work', 'neutral'));

/** Dashboard tile: hours this week by person, work and travel. Managers see everyone, others themselves. */
export function weekHoursTile(ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  if (!auth.can('time')) return null;
  const prefs = payrollPrefs(store.settings());
  const ws = weekOf(ui.today(), prefs.weekStartsOn);
  const entries = store.list('timeEntries', (t) => t.clockIn && ui.localDay(t.clockIn) >= ws && ui.localDay(t.clockIn) <= addDays(ws, 6));
  const ids = auth.isManager() ? [...new Set(entries.map((e) => e.employeeId))] : [auth.current().id].filter(Boolean);
  const rows = ids.map((id) => ({ p: store.get('employees', id), s: weekSheet(entries, { employeeId: id, weekStart: ws, province: prefs.otRule }) }))
    .filter((r) => r.s.totals.total > 0).sort((a, b) => b.s.totals.total - a.s.totals.total);
  const max = Math.max(1, ...rows.map((r) => r.s.totals.total));
  return h('a', { class: 'card time-tile', href: '#/time/week', 'aria-label': 'Hours this week by person, work and travel' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Hours this week by person'), h('span', { class: 'time-legend' }, h('i', { class: 'tw' }), 'work ', h('i', { class: 'tt' }), 'travel')),
    rows.length ? h('div', { class: 'time-bars' }, rows.map(({ p, s }) => h('div', { class: 'time-bar-row' },
      h('span', { class: 'time-bar-name' }, p?.name?.split(' ')[0] || 'Someone'),
      h('span', { class: 'time-bar', role: 'img', 'aria-label': `${p?.name}: ${fmtH(s.totals.work)} h work, ${fmtH(s.totals.travel)} h travel` },
        h('i', { class: 'tw', style: { width: `${(100 * s.totals.work) / max}%` } }), h('i', { class: 'tt', style: { width: `${(100 * s.totals.travel) / max}%` } })),
      h('span', { class: 'num time-bar-val' }, `${fmtH(s.totals.work)} / ${fmtH(s.totals.travel)}`, s.totals.ot + s.totals.dt ? h('span', { class: 'time-ot' }, ` OT ${fmtH(s.totals.ot + s.totals.dt)}`) : null))))
      : h('p', { class: 'muted', style: { margin: 0 } }, 'No hours yet this week.'));
}

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
    const view = ['week', 'location', 'settings', 'map'].includes(ctx.params[0]) ? ctx.params[0] : 'clock';
    const prefs = () => payrollPrefs(store.settings());
    let week = ctx.query.week && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.week) ? weekOf(ctx.query.week, prefs().weekStartsOn) : weekOf(ui.today(), prefs().weekStartsOn);
    let who = ctx.query.who || (mgr ? 'all' : me.id);
    if (!mgr) who = me.id;
    const host = h('div');
    const timers = [];
    const flow = { store, ui, auth, app: ctx.app };
    const activeJobs = () => store.list('jobs', (j) => ['scheduled', 'in-progress', 'on-hold'].includes(j.status)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
    const jobOpts = (blank) => [{ value: '', label: blank }, ...activeJobs().map((j) => ({ value: j.id, label: `${j.number} · ${j.title}` }))];
    const jobName = (id) => { const j = store.get('jobs', id); return j ? `${j.number} · ${j.title}` : null; };
    // Release 1: locks, cost codes and trucks.
    const zone = zoneFor(store.settings()?.company?.province);
    const locksNow = () => locksFrom(store.settings(), store.list('payrollRuns'));
    const lockedEntry = (e) => isLocked(locksNow(), 'timeEntries', e, { zone });
    // Only an exported payroll run locks approval; late hours in a closed month stay approvable (2.6).
    const payrollLocked = (e) => locksNow().payrollEntryIds.has(e.id);
    const codes = () => activeCostCodes(store.list('costCodes'));
    const codeName = (id) => { const c = id ? store.get('costCodes', id) : null; return c ? costCodeLabel(c) : null; };
    const trucks = () => store.list('equipment', (q) => q.active !== false && q.kind === 'truck');
    const truckName = (id) => { const q = id ? store.get('equipment', id) : null; return q ? [q.unitNo, q.name].filter(Boolean).join(' ') : null; };
    const codeOptions = (blank = 'No cost code') => [{ value: '', label: blank }, ...codes().map((c) => ({ value: c.id, label: costCodeLabel(c) }))];

    /** Clock in. With "ask for a code" on and no phase set on the job, ask once; otherwise nothing is asked. */
    function clockInWith(opts) {
      const ask = store.settings().costCodes?.requireOnTime && opts.jobId && !costCodeFor(store, opts.jobId) && codes().length;
      if (!ask) return tracker.clockInFlow(flow, opts);
      ui.formSheet({
        title: 'Which phase are you working on?', submitLabel: 'Clock in',
        fields: [{ label: 'Cost code', name: 'costCodeId', type: 'select', value: '', options: codeOptions('Not sure (the office codes it)'), span: true }],
        onSubmit: (v) => { tracker.clockInFlow(flow, { ...opts, costCodeId: v.costCodeId || null }); },
      });
      return null;
    }

    /** The cost code and truck on the open shift: shown, with a "Change" link (nothing is asked at clock-in). */
    function codingLine(open) {
      if (!open) return null;
      const change = () => ui.formSheet({
        title: 'Cost code and truck',
        fields: [
          { label: 'Cost code', name: 'costCodeId', type: 'select', value: open.costCodeId || '', options: codeOptions() },
          { label: 'Truck', name: 'equipmentId', type: 'select', value: open.equipmentId || '', options: [{ value: '', label: 'No truck' }, ...trucks().map((q) => ({ value: q.id, label: truckName(q.id) }))] },
        ],
        onSubmit: (v) => { store.update('timeEntries', open.id, { costCodeId: v.costCodeId || null, equipmentId: v.equipmentId || null }, { silent: true }); ui.toast('Changed', 'success'); },
      });
      const any = codes().length || trucks().length;
      if (!any) return null;
      return h('div', { class: 'time-coding' },
        h('span', null, `Code: ${codeName(open.costCodeId) || 'none'}`), h('span', null, '·'), h('span', null, `Truck: ${truckName(open.equipmentId) || 'none'}`),
        h('button', { type: 'button', class: 'linkish', onClick: change }, 'Change'));
    }

    /** A locked entry is changed by a correction: minutes added or taken away on its work day. */
    function correctionSheet(entry) {
      const day = entryDay(entry) || ui.today();
      ui.formSheet({
        title: 'Add a correction', submitLabel: 'Add correction',
        fields: [
          { label: 'Minutes to add (negative to take away)', name: 'adjustMinutes', type: 'number', step: '1', value: '', required: true },
          { label: 'Day it belongs to', name: 'workDay', type: 'date', value: day, required: true },
          { label: 'Job', name: 'jobId', type: 'select', value: entry?.jobId || '', options: ui.recordOptions(store.list('jobs'), (j) => `${j.number} · ${j.title}`, 'No job') },
          { label: 'Cost code', name: 'costCodeId', type: 'select', value: entry?.costCodeId || '', options: codeOptions() },
          { label: 'Why', name: 'note', value: '', required: true, span: true },
        ],
        extra: h('p', { class: 'muted loc-small' }, 'These hours were exported to payroll or are in a closed period, so they are not edited. The correction goes in the next payroll export as a prior-period adjustment.'),
        onSubmit(v) {
          const mins = Math.round(Number(v.adjustMinutes));
          if (!mins) { ui.toast('Enter the minutes to add or take away.', 'error'); return false; }
          store.add('timeEntries', {
            kind: 'correction', correctsId: entry?.id || null, workDay: v.workDay, adjustMinutes: mins, employeeId: entry?.employeeId || who,
            jobId: v.jobId || null, costCodeId: v.costCodeId || null, note: v.note, approved: true, approvedAt: new Date().toISOString(), approvedBy: me.id || null, source: 'manual',
          });
          ui.toast('Correction added', 'success');
        },
      });
    }

    /** Recode in approval: pick entries of the week and give them a cost code. */
    function recodeSheet(entries) {
      const open = entries.filter((e) => !lockedEntry(e) && !isCorrection(e));
      if (!open.length) { ui.toast('Nothing to recode: these entries are locked.', 'info'); return; }
      const boxes = open.map((e) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: true, value: e.id }),
        h('span', null, `${ui.fmtDate(e.clockIn, { weekday: 'short', month: 'short', day: 'numeric' })} ${jobName(e.jobId) || 'No job'} · ${fmtH(entryMinutes(e))} h · ${codeName(e.costCodeId) || 'no code'}`)));
      ui.formSheet({
        title: 'Change cost code', submitLabel: 'Change',
        fields: [{ label: 'New cost code', name: 'costCodeId', type: 'select', value: '', options: codeOptions(), span: true }],
        extra: h('div', { class: 'stack' }, boxes),
        onSubmit(v, form) {
          const ids = [...form.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
          for (const id of ids) store.update('timeEntries', id, { costCodeId: v.costCodeId || null }, { silent: true });
          store.log('update', `Recoded ${ids.length} time entr${ids.length === 1 ? 'y' : 'ies'}`, 'timeEntries');
          ui.toast(`${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} recoded`, 'success');
        },
      });
    }

    // ---------- the clock ----------
    function travelSheet() {
      const sel = h('select', { class: 'input', 'aria-label': 'Where are you going?' }, jobOpts('Supply house / not sure yet').map((o) => h('option', { value: o.value }, o.label)));
      const s = ui.openSheet({ title: 'Start travel', dialog: true,
        body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Travel time is recorded against the job you are going to. Pick it now or when you arrive.'),
          h('label', { class: 'field' }, h('span', null, 'Going to'), sel)),
        actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Start travel', { variant: 'primary', icon: 'truck', onClick: () => { s.close(); tracker.startTravelFlow(flow, { toJobId: sel.value || null }); } })] });
    }

    async function arriveSheet(open) {
      const { suggestion } = await tracker.suggestArrival(flow);
      const pre = (suggestion?.inside && suggestion.jobId) || open.jobId || '';
      const sel = h('select', { class: 'input', name: 'arriveJob', 'aria-label': 'Which job?' }, jobOpts('No job (shop / admin)').map((o) => h('option', { value: o.value, selected: o.value === pre }, o.label)));
      const s = ui.openSheet({ title: 'Arrived', dialog: true,
        body: h('div', { class: 'stack' },
          suggestion?.inside ? h('p', { class: 'loc-hint', style: { margin: 0 } }, ui.icon('map-pin', 16), ` You're at ${jobName(suggestion.jobId)}.`) : null,
          h('label', { class: 'field' }, h('span', null, 'Start work at'), sel)),
        actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Start work here', { variant: 'primary', icon: 'play', onClick: () => { s.close(); tracker.arriveFlow(flow, { jobId: sel.value || null }); } })] });
    }

    function clockPanel() {
      if (!me.id) return h('div', { class: 'card ops-clock' }, h('p', { class: 'muted' }, mgr ? 'Your account is not linked to an employee record, so it has no clock. Link it in Account > Members.' : 'Pick who is using this device (avatar at the bottom of the rail) to clock in.'));
      const open = openEntry(store, me.id);
      const travel = open && kindOf(open) === 'travel';
      const readout = h('div', { class: 'ops-clock-time num', 'aria-live': 'off' }, open ? clockText(liveMin(open)) : '00:00:00');
      if (open) timers.push(setInterval(() => { readout.textContent = clockText(liveMin(store.get('timeEntries', open.id) || open)); }, 1000));
      const preset = (activeJobs().find((j) => (j.crewIds || []).includes(me.id)) || {}).id || '';
      const jobSel = h('select', { class: 'input', name: 'clockJob', 'aria-label': 'Job' }, jobOpts('No job (shop / admin)').map((o) => h('option', { value: o.value, selected: o.value === preset }, o.label)));
      const note = h('input', { class: 'input', placeholder: 'Note (optional)', value: open?.note || '', 'aria-label': 'Note' });
      const ls = locationSettings(store.settings());
      const state = locationState(store.list('locationConsents'), me.id, store.settings());
      const toggleBreak = () => {
        const cur = store.get('timeEntries', open.id);
        if (cur.breakStart) {
          const mins = Math.round((Date.now() - Date.parse(cur.breakStart)) / 60000);
          store.update('timeEntries', cur.id, { breakMins: (Number(cur.breakMins) || 0) + mins, breakStart: null }, { silent: true });
          ui.toast(`Break ended · ${mins} min`);
        } else {
          store.update('timeEntries', cur.id, { breakStart: new Date().toISOString() }, { silent: true });
          ui.toast('On break');
        }
      };
      const status = !open ? 'Off the clock' : open.breakStart ? 'On break' : travel ? 'Travelling' : 'On the clock';
      const where = !open ? `Hi ${me.name.split(' ')[0]}. Pick a job and clock in.`
        : travel ? `${open.travelFromJobId ? `From ${store.get('jobs', open.travelFromJobId)?.number || 'a job'}` : 'Travel'} → ${open.jobId ? jobName(open.jobId) : 'destination not set'}`
          : jobName(open.jobId) || 'No job';
      const locLine = !ls.enabled ? null
        : !open ? h('div', { class: 'muted loc-small' }, ui.icon('map-pin', 14), state === 'granted' ? ' Location is recorded only while you are clocked in.' : state === 'ask' ? ' You will be asked about location when you clock in.' : ' Location is off for you.', ' ', h('a', { href: '#/time/location' }, 'My location'))
          : h('div', { class: 'row loc-line' }, locBadge(ui, open) || h('span', { class: 'muted loc-small' }, open.clockInLoc ? `Location recorded at ${ui.fmtTime(open.clockInLoc.at || open.clockIn)}` : state === 'granted' ? 'Getting your location…' : 'No location'));
      return h('div', { class: ['card', 'ops-clock', open ? (open.breakStart ? 'on-break' : travel ? 'travelling' : 'running') : null], dataset: { state: open ? kindOf(open) : 'off' } },
        h('div', { class: 'ops-clock-face' },
          h('div', { class: 'ops-clock-ring' }, ui.icon(travel ? 'truck' : 'clock', 28)),
          h('div', null,
            h('div', { class: 'ops-clock-status' }, status, open ? h('span', { class: 'muted' }, ` since ${ui.fmtTime(open.clockIn)}`) : null),
            readout,
            h('div', { class: 'muted' }, where, open?.breakMins ? ` · ${open.breakMins} min break` : ''),
            codingLine(open),
            locLine)),
        h('div', { class: 'ops-clock-controls' },
          open ? null : jobSel,
          note,
          open
            ? h('div', { class: 'row' },
              travel ? ui.button('Arrived', { variant: 'primary', icon: 'map-pin', size: 'lg', onClick: () => arriveSheet(open) })
                : ui.button(open.breakStart ? 'End break' : 'Start break', { icon: open.breakStart ? 'play' : 'stop', size: 'lg', onClick: toggleBreak }),
              travel || open.breakStart ? null : ui.button('Travel', { icon: 'truck', size: 'lg', onClick: travelSheet }),
              ui.button('Clock out', { variant: 'dark', icon: 'log-out', size: 'lg', onClick: () => tracker.clockOutFlow(flow, { note: note.value }).then((e) => e && ui.toast(`Clocked out · ${fmtH(entryMinutes(e))} h`, 'success')) }))
            : h('div', { class: 'row' },
              ui.button('Clock in', { variant: 'primary', icon: 'play', size: 'lg', onClick: () => clockInWith({ jobId: jobSel.value || null, note: note.value }) }),
              ui.button('Start with travel', { icon: 'truck', size: 'lg', onClick: () => clockInWith({ jobId: jobSel.value || null, kind: 'travel', note: note.value }) }))));
    }

    function reviewButton(e) {
      return mgr && e.flag && !e.flag.reviewedAt ? ui.button('Reviewed', { size: 'sm', icon: 'check', onClick: async (ev) => {
        ev?.stopPropagation?.();
        const note = await ui.promptDialog(`${store.get('employees', e.employeeId)?.name || 'Someone'} ${e.kind === 'travel' ? 'started travel' : 'clocked in'} ${e.flag.text}. Note (optional):`, { title: 'Review off-site clock-in', okLabel: 'Mark reviewed' });
        if (note == null) return;
        reviewFlag(store, e.id, { by: me.id, note });
        ui.toast('Marked reviewed', 'success');
      } }) : null;
    }

    function whoIsOn() {
      const open = store.list('timeEntries', (t) => t.clockIn && !t.clockOut);
      return [h('h2', { class: 'section' }, `Who's on the clock (${open.length})`),
        open.length ? h('div', { class: 'list' }, open.map((t) => {
          const p = store.get('employees', t.employeeId);
          const span = h('span', { class: 'num' }, clockText(liveMin(t)));
          timers.push(setInterval(() => { span.textContent = clockText(liveMin(store.get('timeEntries', t.id) || t)); }, 1000));
          return h('div', { class: 'list-row', dataset: { entry: t.id } },
            h('span', { class: 'avatar', style: { background: p?.color || '#5f5a51' } }, ui.initials(p?.name)),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, p?.name || 'Unknown'),
              h('div', { class: 'meta' }, `${kindOf(t) === 'travel' ? 'Travelling to ' : ''}${jobName(t.jobId) || (kindOf(t) === 'travel' ? 'a job' : 'No job')} · in at ${ui.fmtTime(t.clockIn)}`)),
            t.breakStart ? ui.badge('on break', 'warning') : null, locBadge(ui, t), reviewButton(t), span);
        })) : h('p', { class: 'muted' }, 'Nobody is clocked in.')];
    }

    function needsReview() {
      if (!mgr) return null;
      const since = addDays(ui.today(), -14);
      const flagged = store.list('timeEntries', (t) => t.flag && !t.flag.reviewedAt && t.clockOut && ui.localDay(t.clockIn) >= since).sort((a, b) => b.clockIn.localeCompare(a.clockIn));
      if (!flagged.length) return null;
      return [h('h2', { class: 'section' }, `Off-site clock-ins to review (${flagged.length})`),
        h('div', { class: 'list' }, flagged.map((t) => h('div', { class: 'list-row', dataset: { entry: t.id } },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `${store.get('employees', t.employeeId)?.name || 'Someone'} · ${ui.fmtDate(t.clockIn, { weekday: 'short', month: 'short', day: 'numeric' })} ${ui.fmtTime(t.clockIn)}`),
            h('div', { class: 'meta' }, `${jobName(t.jobId) || 'No job'} · ${t.flag.text}${t.siteCheck?.accuracyM != null ? ` (±${t.siteCheck.accuracyM} m)` : ''}`)),
          reviewButton(t))))];
    }

    // ---------- entries ----------
    function editEntry(entry) {
      // Exported to payroll or in a closed period: changed by a correction, never edited.
      if (entry && (lockedEntry(entry) || isCorrection(entry))) {
        if (isCorrection(entry)) { ui.toast(lockedEntry(entry) ? 'This correction is locked.' : 'Corrections are not edited: add another one.', 'info'); return; }
        if (canApprove) correctionSheet(entry); else ui.toast('These hours are locked. Ask the office to add a correction.', 'info');
        return;
      }
      const people = store.list('employees', (e) => e.active !== false || e.id === entry?.employeeId);
      const jobs = store.list('jobs');
      const whoDefault = entry?.employeeId || (who !== 'all' ? who : people[0]?.id);
      ui.formSheet({
        title: entry ? 'Edit time entry' : 'Add time entry',
        fields: [
          { label: 'Employee', name: 'employeeId', type: 'select', value: whoDefault, options: people.map((p) => ({ value: p.id, label: p.name })) },
          { label: 'Type', name: 'kind', type: 'select', value: kindOf(entry), options: [{ value: 'work', label: 'Work' }, { value: 'travel', label: 'Travel (to the job below)' }] },
          { label: 'Job', name: 'jobId', type: 'select', value: entry?.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`, 'No job') },
          { label: 'Clock in', name: 'clockIn', type: 'datetime-local', value: toLocalInput(entry?.clockIn) || `${week}T07:00`, required: true },
          { label: 'Clock out', name: 'clockOut', type: 'datetime-local', value: toLocalInput(entry?.clockOut) || (entry ? '' : `${week}T15:30`), hint: 'Leave blank if still on the clock' },
          { label: 'Break (minutes)', name: 'breakMins', type: 'number', min: '0', value: entry?.breakMins ?? 30 },
          codes().length ? { label: 'Cost code', name: 'costCodeId', type: 'select', value: entry?.costCodeId || '', options: codeOptions('The job\'s phase') } : null,
          { label: 'Note', name: 'note', value: entry?.note || '', span: true },
        ].filter(Boolean),
        danger: entry ? { label: 'Delete', onClick: () => store.remove('timeEntries', entry.id) } : null,
        onSubmit(v) {
          const data = { ...v, jobId: v.jobId || null, breakMins: Number(v.breakMins) || 0, clockIn: new Date(v.clockIn).toISOString(), clockOut: v.clockOut ? new Date(v.clockOut).toISOString() : null };
          if ('costCodeId' in v) data.costCodeId = v.costCodeId || costCodeFor(store, data.jobId);
          if (data.clockOut && data.clockOut <= data.clockIn) { ui.toast('Clock out must be after clock in', 'error'); return false; }
          const other = openEntry(store, data.employeeId);
          if (!data.clockOut && other && other.id !== entry?.id) { ui.toast('That person already has an open shift', 'error'); return false; }
          if (entry) store.update('timeEntries', entry.id, data);
          else store.add('timeEntries', { ...data, approved: false, breakStart: null, source: 'manual' });
          ui.toast('Time saved', 'success');
        },
      });
    }

    function entriesTable(rows, { onRowClick } = {}) {
      return ui.table({
        columns: [
          { key: 'day', label: 'Day', render: (t) => ui.fmtDate(isCorrection(t) ? t.workDay : t.clockIn, { weekday: 'short', month: 'short', day: 'numeric' }) },
          { key: 'kind', label: 'Type', render: (t) => (isCorrection(t) ? ui.badge('correction', 'info') : kindBadge(ui, t)) },
          { key: 'job', label: 'Job', render: (t) => { const j = store.get('jobs', t.jobId); return j ? h('a', { href: '#/jobs/' + j.id, onClick: (e) => e.stopPropagation() }, j.number) : h('span', { class: 'muted' }, '—'); } },
          { key: 'code', label: 'Code', render: (t) => { const c = t.costCodeId ? store.get('costCodes', t.costCodeId) : null; return c ? h('span', { title: costCodeLabel(c) }, c.code) : h('span', { class: 'muted' }, '—'); } },
          { key: 'in', label: 'In – out', render: (t) => (isCorrection(t) ? h('span', { class: 'time-correction', title: t.note || '' }, `${t.adjustMinutes > 0 ? '+' : ''}${fmtH(t.adjustMinutes)} h`) : `${ui.fmtTime(t.clockIn)} – ${t.clockOut ? ui.fmtTime(t.clockOut) : 'open'}`) },
          { key: 'break', label: 'Break', align: 'right', render: (t) => (isCorrection(t) ? '' : `${t.breakMins || 0}m`) },
          { key: 'hours', label: 'Hours', align: 'right', render: (t) => fmtH(entryMinutes(t)) },
          { key: 'loc', label: 'Location', render: (t) => h('span', { class: 'row loc-cell' }, locBadge(ui, t) || h('span', { class: 'muted' }, '—'), reviewButton(t)) },
          { key: 'ok', label: 'Approved', render: (t) => h('span', { class: 'row-inline' }, payrollLocked(t) ? h('span', { class: 'time-locked', title: 'Exported to payroll: add a correction to change it' }, ui.icon('lock', 14), 'locked') : (canApprove && (t.clockOut || isCorrection(t))
            ? h('input', { type: 'checkbox', checked: !!t.approved, 'aria-label': 'Approve entry', onClick: (e) => e.stopPropagation(),
              onChange: (e) => store.update('timeEntries', t.id, e.target.checked ? { approved: true, approvedAt: new Date().toISOString(), approvedBy: me.id || null } : { approved: false, approvedAt: null, approvedBy: null }, { summary: `${e.target.checked ? 'approved' : 'unapproved'} time ${isCorrection(t) ? t.workDay : ui.localDay(t.clockIn)}` }) })
            : t.approved ? ui.badge('approved', 'success') : ui.badge(t.clockOut ? 'pending' : 'open', t.clockOut ? 'warning' : 'info')),
            // QuickBooks (contract 8.5): office roles only; qboBadge is null for foremen and crew.
            t.approved ? qboBadge(ctx, 'timeEntries', t.id, { record: t }) : null) },
        ],
        rows, onRowClick,
        empty: ui.empty({ icon: 'clock', title: 'No time this week', text: 'Nothing recorded for this week yet.' }),
      });
    }

    // ---------- timesheets ----------
    const weekEntries = () => store.list('timeEntries', (t) => { const d = isCorrection(t) ? t.workDay : t.clockIn && ui.localDay(t.clockIn); return d && d >= addDays(week, -1) && d <= addDays(week, 7); });
    const sheetFor = (id, entries = weekEntries()) => weekSheet(entries, { employeeId: id, weekStart: week, province: prefs().otRule });

    function approveSheet(sheet, person) {
      const n = approveEntries(store, sheet.entries, { by: me.id });
      store.log('approve', `Approved week ${week} for ${person?.name || 'someone'} (${n} entr${n === 1 ? 'y' : 'ies'})`, 'timeEntries');
      return n;
    }

    function personSheet(id) {
      const s = sheetFor(id);
      const person = store.get('employees', id);
      const rule = s.rule;
      const t = s.totals;
      const jobsById = (jid) => store.get('jobs', jid);
      const client = (j) => (j?.clientId ? store.get('clients', j.clientId)?.name : '');
      return [
        h('div', { class: 'grid ops-stats time-stats' },
          ui.stat({ label: 'Work', value: fmtH(t.work), hint: 'hours on jobs' }),
          ui.stat({ label: 'Travel', value: fmtH(t.travel), hint: 'between jobs' }),
          ui.stat({ label: 'Total', value: fmtH(t.total), hint: `${fmtH(t.reg)} regular` }),
          ui.stat({ label: 'Overtime', value: fmtH(t.ot + t.dt), hint: t.dt ? `${fmtH(t.dt)} double time` : `${rule.rate}x`, tone: t.ot + t.dt ? 'accent' : null }),
          ui.stat({ label: 'Status', value: s.approvedAll ? 'Approved' : s.counts.entries ? `${s.counts.pending} pending` : '—', hint: s.counts.open ? `${s.counts.open} open` : s.counts.flagged ? `${s.counts.flagged} to review` : '', tone: s.approvedAll ? 'success' : null })),
        h('p', { class: 'muted loc-small' }, `Overtime: ${ruleText(rule)}.`, rule.note ? ` ${rule.note}` : ''),
        h('div', { class: 'ops-week time-week' }, s.days.map((d) => h('div', { class: ['ops-week-day', d.date === ui.today() ? 'today' : null, d.ot + d.dt ? 'over' : null] },
          h('span', { class: 'muted ops-small' }, ui.fmtDate(d.date, { weekday: 'short', day: 'numeric' })),
          h('strong', { class: 'num' }, d.total ? fmtH(d.total) : '—'),
          d.travel ? h('span', { class: 'ops-small time-travel' }, `${fmtH(d.travel)} travel`) : null,
          d.ot + d.dt ? h('span', { class: 'ops-small' }, `${fmtH(d.ot + d.dt)} OT`) : null,
          d.breakShort ? h('span', { class: 'ops-small time-warn', title: `${rule.meal.mins} min meal break owed after ${rule.meal.afterH} h` }, 'break?') : null))),
        s.jobs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table time-jobs' },
          h('thead', null, h('tr', null, h('th', null, 'Job / customer'), s.days.map((d) => h('th', { class: 'right' }, ui.fmtDate(d.date, { weekday: 'short' }))), h('th', { class: 'right' }, 'Work'), h('th', { class: 'right' }, 'Travel'))),
          h('tbody', null, s.jobs.map((j) => {
            const job = jobsById(j.jobId);
            return h('tr', null,
              h('td', null, job ? h('div', null, h('strong', null, job.number), ` ${job.title}`, h('div', { class: 'muted ops-small' }, client(job) || '')) : h('span', { class: 'muted' }, 'No job (shop / admin)')),
              s.days.map((d) => { const c = j.days[d.date]; return h('td', { class: 'right num' }, c ? [c.work ? fmtH(c.work) : '', c.travel ? h('span', { class: 'time-travel' }, ` +${fmtH(c.travel)}t`) : null] : ''); }),
              h('td', { class: 'right num' }, fmtH(j.work)), h('td', { class: 'right num' }, fmtH(j.travel)));
          })))) : null,
        h('h2', { class: 'section' }, 'Entries'),
        entriesTable(s.entries, { onRowClick: mgr ? editEntry : null }),
        canApprove && s.counts.pending ? h('div', { class: 'row time-actions' }, ui.button(`Approve week for ${person?.name?.split(' ')[0] || 'them'}`, { variant: 'primary', icon: 'check', onClick: () => {
          const n = approveSheet(s, person);
          ui.toast(`Week approved (${n} entr${n === 1 ? 'y' : 'ies'})`, 'success');
        } }), s.counts.flagged ? h('span', { class: 'muted loc-small' }, `${s.counts.flagged} off-site clock-in${s.counts.flagged === 1 ? '' : 's'} not reviewed yet.`) : null) : null,
        canApprove && codes().length && s.entries.length ? h('div', { class: 'row time-actions' }, ui.button('Change cost code', { icon: 'edit', onClick: () => recodeSheet(s.entries) }),
          ui.button('Add a correction', { variant: 'ghost', icon: 'plus', onClick: () => correctionSheet({ employeeId: id }) })) : null,
      ];
    }

    /**
     * Export payroll (8.2): the file, then (ticked by default) the lock. Late hours and corrections
     * from earlier periods go in as prior-period rows; entries in the week that are open or not
     * approved stay out and wait in Late hours. The lock is a server call; offline it waits on Books.
     */
    function exportPayroll(format, sheets) {
      const locks = locksNow();
      const end = addDays(week, 6);
      const inRun = (e) => locks.payrollEntryIds.has(e.id);
      const weekRows = sheets.flatMap((s) => s.entries);
      const ready = (e) => (isCorrection(e) || e.clockOut) && e.approved && !inRun(e);
      const leftOut = weekRows.filter((e) => !ready(e) && !inRun(e));
      // Earlier days no run has taken: late hours (on or before the exported-through date) and corrections.
      const late = store.list('timeEntries', (e) => {
        const d = entryDay(e);
        return d && d < week && !inRun(e) && (isCorrection(e) || e.clockOut) && (isLateHours(e, locks, { zone }) || isCorrection(e));
      });
      const people = new Map(store.list('employees').map((e) => [e.id, e]));
      const name = (e) => people.get(e.employeeId)?.name || 'Someone';
      const lockBox = h('input', { type: 'checkbox', checked: true, name: 'lock' });
      const lateBoxes = late.map((e) => h('label', null, h('input', { type: 'checkbox', checked: Boolean(e.approved), disabled: !e.approved, value: e.id }),
        h('span', null, `${name(e)} · ${entryDay(e)} · ${isCorrection(e) ? `correction ${e.adjustMinutes > 0 ? '+' : ''}${fmtH(e.adjustMinutes)} h` : `${fmtH(entryMinutes(e))} h`}${e.approved ? '' : ' (not approved yet)'}`)));
      const body = h('div', { class: 'stack' },
        late.length ? h('div', { class: 'time-late' }, h('strong', null, `Late hours and corrections from earlier periods (${late.length})`), ...lateBoxes) : null,
        leftOut.length ? h('div', { class: 'time-late' }, h('strong', null, `These ${leftOut.length} entr${leftOut.length === 1 ? 'y is' : 'ies are'} not in this run. They will wait in Late hours for the next run.`),
          h('ul', { class: 'time-warnings' }, leftOut.map((e) => h('li', null, `${name(e)} · ${entryDay(e)} · ${e.clockOut || isCorrection(e) ? 'not approved' : 'still on the clock'}`)))) : null,
        h('label', { class: 'field check' }, lockBox, h('span', null, 'Lock these timesheets (recommended): exported hours can then only change by a correction')),
        h('p', { class: 'muted loc-small' }, PAYROLL_FORMATS[format]?.note || ''));
      const s = ui.openSheet({ title: `Export payroll ${ui.fmtDate(week, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(end, { month: 'short', day: 'numeric' })}`, body,
        actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Export', { variant: 'primary', icon: 'download', onClick: () => { s.close(); run(); } })] });

      async function run() {
        const lock = lockBox.checked;
        const lateIds = new Set(lateBoxes.map((l) => l.querySelector('input')).filter((x) => x.checked).map((x) => x.value));
        const lateEntries = late.filter((e) => lateIds.has(e.id));
        // With the lock, the file holds exactly what the run locks: approved, closed entries not exported before.
        const fileSheets = lock ? sheets.map((sh) => weekSheet(sh.entries.filter(ready), { employeeId: sh.employeeId, weekStart: week, province: prefs().otRule })) : sheets;
        const ctxp = { employees: people, jobs: new Map(store.list('jobs').map((j) => [j.id, j])), clients: new Map(store.list('clients').map((c) => [c.id, c])), periodStart: week, periodEnd: end, lateEntries,
          // Late hours count overtime on their own week, against what earlier runs already paid.
          paidEntries: store.list('timeEntries', inRun), province: prefs().otRule, weekStartsOn: prefs().weekStartsOn };
        const out = payrollCsv(format, fileSheets, ctxp);
        ui.download(`${PAYROLL_FORMATS[format].file}-${week}.csv`, out.text, 'text/csv');
        store.log('export', `Payroll CSV (${PAYROLL_FORMATS[format].label}) week ${week}`, 'timeEntries');
        if (out.warnings.length) showWarnings(`Exported ${out.count} row${out.count === 1 ? '' : 's'}`, out.warnings, PAYROLL_FORMATS[format].note);
        else ui.toast(`Exported ${out.count} row${out.count === 1 ? '' : 's'} for ${store.settings().company?.name || 'payroll'}`, 'success');
        if (!lock) return;
        const entryIds = weekRows.filter(ready).map((e) => e.id);
        if (!entryIds.length && !lateEntries.length) return;
        const req = {
          id: `run-${week}-${Date.now().toString(36)}`, from: week, to: end, format, entryIds, lateEntryIds: [...lateIds],
          employeeIds: [...new Set([...entryIds, ...lateIds].map((x) => store.get('timeEntries', x)?.employeeId).filter(Boolean))],
          totals: { otMinutes: fileSheets.reduce((n, sh) => n + sh.totals.ot + sh.totals.dt, 0) }, lockThrough: true,
        };
        await lockRun(req, leftOut.length > 0);
      }
    }

    /** POST the run; ask about entries only the server knows of; keep it for Books when offline. */
    async function lockRun(req, ack) {
      if (!auth.synced || !ctx.app?.api) { ui.toast('Demo: timesheets are locked when you are signed in to your company.', 'info', 4000); return; }
      try {
        await ctx.app.sync?.syncNow?.().catch(() => {});
        await ctx.app.api.post('/api/v1/closing/payroll-runs', { ...req, leftOutAck: ack });
        await ctx.app.sync?.syncNow?.().catch(() => {});
        ui.toast('Timesheets locked', 'success');
      } catch (e) {
        if (e.code === 'unexported_entries' && !ack) {
          const n = e.details?.entries?.length || 0;
          if (await ui.confirmDialog(`${n} more entr${n === 1 ? 'y' : 'ies'} in this period ${n === 1 ? 'is' : 'are'} not in this run (from other devices). They will wait in Late hours for the next run.`, { title: 'Lock anyway?', okLabel: 'Lock', danger: false })) await lockRun(req, true);
          return;
        }
        if (e.code === 'offline' || e.status === 0 || e.status >= 500) {
          store.setMeta(PENDING_RUNS_META, [...(store.meta(PENDING_RUNS_META) || []), req]);
          ui.toast('Exported. The timesheets lock when you are back online (Books → Payroll).', 'info', 5000);
          return;
        }
        ui.toast(e.message || 'The timesheets could not be locked.', 'error', 5000);
      }
    }

    async function fillTemplate(sheets) {
      const file = await ui.pickFile('.csv,text/csv');
      if (!file) return;
      const rows = parseCSV(await file.text());
      const ctxp = { employees: new Map(store.list('employees').map((e) => [e.id, e])), jobs: new Map(store.list('jobs').map((j) => [j.id, j])), clients: new Map(), periodStart: week, periodEnd: addDays(week, 6) };
      const r = fillWagepointTemplate(rows, sheets, ctxp);
      if (!r.filled) { showWarnings('Nothing filled', r.warnings); return; }
      ui.download(`wagepoint-hours-${week}.csv`, toCSV(r.rows), 'text/csv');
      store.log('export', `Wagepoint template filled for week ${week}`, 'timeEntries');
      if (r.warnings.length) showWarnings(`Filled ${r.filled} row${r.filled === 1 ? '' : 's'}`, r.warnings); else ui.toast(`Filled ${r.filled} rows`, 'success');
    }

    function showWarnings(title, list, note) {
      const s = ui.openSheet({ title, dialog: true, body: h('div', { class: 'stack' }, note ? h('p', { class: 'muted', style: { margin: 0 } }, note) : null, h('ul', { class: 'time-warnings' }, list.map((w) => h('li', null, w)))),
        actions: [ui.button('OK', { variant: 'primary', onClick: () => s.close() })] });
    }

    function crewSheet() {
      const entries = weekEntries();
      const ids = [...new Set([...store.list('employees', (e) => e.active !== false).map((e) => e.id), ...entries.map((e) => e.employeeId)])];
      const sheets = ids.map((id) => sheetFor(id, entries)).filter((s) => s.counts.entries);
      const people = new Map(store.list('employees').map((e) => [e.id, e]));
      sheets.sort((a, b) => (people.get(a.employeeId)?.name || '').localeCompare(people.get(b.employeeId)?.name || ''));
      const fmt = h('select', { class: 'input', name: 'payrollFormat', 'aria-label': 'Payroll format' }, Object.entries(PAYROLL_FORMATS).map(([v, f]) => h('option', { value: v, selected: v === prefs().format }, f.label)));
      const pending = sheets.reduce((n, s) => n + s.counts.pending, 0);
      return [
        h('div', { class: 'table-wrap' }, h('table', { class: 'table time-crew' },
          h('thead', null, h('tr', null, ['Person', 'Work', 'Travel', 'Total', 'Overtime', 'Location', 'Status', ''].map((x, i) => h('th', { class: i && i < 5 ? 'right' : null }, x)))),
          h('tbody', null, sheets.length ? sheets.map((s) => {
            const p = people.get(s.employeeId);
            return h('tr', { class: 'click', dataset: { emp: s.employeeId }, onClick: () => { who = s.employeeId; draw(); } },
              h('td', null, h('strong', null, p?.name || 'Unknown')),
              h('td', { class: 'right num' }, fmtH(s.totals.work)), h('td', { class: 'right num' }, fmtH(s.totals.travel)), h('td', { class: 'right num' }, fmtH(s.totals.total)),
              h('td', { class: 'right num' }, s.totals.ot + s.totals.dt ? fmtH(s.totals.ot + s.totals.dt) : '—'),
              h('td', null, s.counts.flagged ? ui.badge(`${s.counts.flagged} to review`, 'danger') : h('span', { class: 'muted' }, '—')),
              h('td', null, s.approvedAll ? ui.badge('approved', 'success') : s.counts.open ? ui.badge(`${s.counts.open} open`, 'info') : ui.badge(`${s.counts.pending} pending`, 'warning')),
              h('td', null, canApprove && s.counts.pending ? ui.button('Approve', { size: 'sm', icon: 'check', onClick: (e) => { e.stopPropagation(); approveSheet(s, p); ui.toast(`${p?.name}: week approved`, 'success'); } }) : null));
          }) : h('tr', null, h('td', { colspan: '8', class: 'muted' }, 'No time recorded this week.'))))),
        canApprove ? h('div', { class: 'row time-actions' },
          pending ? ui.button(`Approve week for everyone (${pending})`, { variant: 'primary', icon: 'check', onClick: () => {
            let n = 0;
            for (const s of sheets) n += approveSheet(s, people.get(s.employeeId));
            ui.toast(`Approved ${n} entr${n === 1 ? 'y' : 'ies'}`, 'success');
          } }) : null,
          h('span', { class: 'grow' }),
          h('label', { class: 'row' }, h('span', { class: 'muted' }, 'Payroll'), fmt),
          ui.button('Export CSV', { icon: 'download', onClick: () => exportPayroll(fmt.value, sheets) }),
          ui.button('Fill my Wagepoint template', { variant: 'ghost', icon: 'upload', onClick: () => fillTemplate(sheets) })) : null,
        canApprove ? h('p', { class: 'muted loc-small' }, PAYROLL_FORMATS[prefs().format]?.note || '') : null,
      ];
    }

    function timesheets() {
      const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
      const end = addDays(week, 6);
      return [
        h('div', { class: 'row ops-toolbar' },
          ui.button('', { icon: 'chevron-left', title: 'Previous week', onClick: () => { week = addDays(week, -7); draw(); } }),
          h('strong', null, `${ui.fmtDate(week, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(end, { month: 'short', day: 'numeric' })}`),
          ui.button('', { icon: 'chevron-right', title: 'Next week', onClick: () => { week = addDays(week, 7); draw(); } }),
          mgr ? h('select', { class: 'input ops-who', name: 'who', 'aria-label': 'Employee', onChange: (e) => { who = e.target.value; draw(); } },
            h('option', { value: 'all', selected: who === 'all' }, 'Everyone'),
            people.map((p) => h('option', { value: p.id, selected: p.id === who }, p.name))) : null,
          h('span', { class: 'grow' }),
          mgr ? ui.button('Add entry', { icon: 'plus', onClick: () => editEntry(null) }) : null),
        who === 'all' ? crewSheet() : personSheet(who),
      ];
    }

    // ---------- page ----------
    const tabs = () => {
      const ls = locationSettings(store.settings());
      return [
        { id: 'clock', label: 'Clock' }, { id: 'week', label: 'Timesheets' },
        ls.enabled ? { id: 'location', label: 'My location' } : null,
        mgr && ls.enabled && ls.liveCrewMap ? { id: 'map', label: 'Crew map' } : null,
        auth.can('settings') ? { id: 'settings', label: 'Settings' } : null,
      ].filter(Boolean);
    };

    const draw = () => {
      timers.splice(0).forEach(clearInterval);
      const body = view === 'week' ? timesheets()
        : view === 'location' ? [myLocation(ctx, me.id)]
          : view === 'settings' && auth.can('settings') ? [settingsForm(ctx)]
            : view === 'map' && mgr ? [crewMap(ctx)]
              : [clockPanel(), mgr ? whoIsOn() : null, needsReview(),
                me.id ? h('p', { class: 'muted' }, h('a', { href: '#/time/week' }, 'Your timesheet for this week'), mgr ? ' · approvals and payroll export' : '') : null];
      ui.clear(host).append(ui.page({ title: 'Time clock', subtitle: ui.fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }) },
        h('div', { class: 'ops-tabs-row' }, ui.tabs(tabs(), view, (id) => ctx.nav(id === 'clock' ? '#/time' : `#/time/${id}`))),
        body));
    };
    root.append(host);
    draw();
    // Settings forms and the crew map keep their own state; don't redraw them on every sync.
    const live = view === 'clock' || view === 'week' || view === 'location';
    let pending = null;
    const later = () => { clearTimeout(pending); pending = setTimeout(draw, 60); };
    const offs = live ? ['timeEntries', 'jobs', 'employees', 'locationConsents', 'locationPoints'].map((c) => store.on(c, later)) : [];
    return () => { offs.forEach((f) => f()); clearTimeout(pending); timers.splice(0).forEach(clearInterval); };
  },
};

