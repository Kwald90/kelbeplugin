// Schedule (S16): who is where, as a Day timeline, a Week board of crew x days, or a Month calendar.
// Managers tap an empty slot to assign, tap a chip to edit it, and drag a chip (long-press then drag on
// touch) to move it to another day, person or time. Assignments carry a start and an end time; the
// numeric `hours` is still written because the job, employee, dashboard and safety screens read it.
// The pure logic (times, ranges, lanes, moves) is lib/schedule.js.
import { jobColor } from './jobs.js';
import {
  weekStart, addDays, monthStart, entryTimes, timeFields, spanMinutes, isOvernight, shiftTimes, snapMinutes, parseTime, toTime,
  clockLabel, rangeLabel, hoursLabel, viewRange, stepAnchor, initialState, entryFilter, totalHours,
  daySegments, assignLanes, dayWindow, jobsOnDay, movePatch, rememberedTimes,
} from '../lib/schedule.js';
import { noteUse, rankByUse } from '../lib/usage-rank.js';
import { jobFocus, onJobFocus } from '../lib/job-focus.js';

// employees.js and time.js import these from here.
export { weekStart, addDays };

const VIEW_KEY = 'kc.schedule.view';
const TIMES_KEY = 'kc.schedule.times';
const LONG_PRESS_MS = 380;
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const hour12 = (() => { try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false; } catch { return false; } })();
const isPhone = () => { try { return window.matchMedia('(max-width: 760px)').matches; } catch { return false; } };
/** h() copies style objects with Object.assign, which drops custom properties; set those directly. */
const cssVar = (el, name, value) => { el.style.setProperty(name, value); return el; };

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
    const uid = auth.current?.()?.id;
    const init = initialState(ctx.query, read(VIEW_KEY), ui.today());
    let view = init.view;
    let anchor = init.anchor;
    let mobileDay = anchor;
    let focus = jobFocus(store, auth);
    const filters = { employeeId: '', jobId: focus };
    const host = h('div');

    const activeJobs = () => store.list('jobs', (j) => !['complete', 'invoiced', 'cancelled'].includes(j.status)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
    const activePeople = () => store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
    const jobLabel = (j) => (j ? `${j.number} · ${j.title}` : 'Deleted job');
    const shortDay = (d) => ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const hrs = (s) => hoursLabel(s.hours ?? entryTimes(s).hours);

    // ---------- the assignment form ----------

    function assign(slot = {}, entry) {
      if (!canEdit) return;
      const jobs = activeJobs();
      const wantJob = entry?.jobId || filters.jobId || focus;
      if (wantJob && !jobs.find((j) => j.id === wantJob)) { const j = store.get('jobs', wantJob); if (j) jobs.unshift(j); }
      if (!jobs.length) return ui.toast('Create an active job first', 'error');
      const people = activePeople();
      const who = entry?.employeeId || slot.employeeId || filters.employeeId;
      if (who && !people.find((p) => p.id === who)) { const p = store.get('employees', who); if (p) people.unshift(p); }
      const usual = rememberedTimes(read(TIMES_KEY));
      let times = usual;
      if (entry) times = entryTimes(entry);
      else if (slot.startTime) times = { startTime: slot.startTime, endTime: toTime(parseTime(slot.startTime) + spanMinutes(usual.startTime, usual.endTime)) };

      const readout = h('output', { class: 'sched-hours-value', 'aria-live': 'polite' });
      const readoutNote = h('span', { class: 'hint' });
      const sheet = ui.formSheet({
        title: entry ? 'Edit assignment' : 'Assign to job',
        submitLabel: entry ? 'Save' : 'Assign',
        fields: [
          { label: 'Job', name: 'jobId', type: 'select', value: wantJob || '', required: true, span: true, options: rankByUse('jobs', jobs, (j) => j.id, { uid }).map((j) => ({ value: j.id, label: jobLabel(j) })) },
          { label: 'Who', name: 'employeeId', type: 'select', value: who || '', required: true, options: rankByUse('employees', people, (p) => p.id, { uid }).map((p) => ({ value: p.id, label: p.name })) },
          { label: 'Date', name: 'date', type: 'date', value: entry?.date || slot.date || ui.today(), required: true },
          { label: 'Start time', name: 'startTime', type: 'time', value: times.startTime, required: true },
          { label: 'End time', name: 'endTime', type: 'time', value: times.endTime, required: true },
          h('div', { class: 'field sched-hours' }, h('span', null, 'Hours'), readout, readoutNote),
          { label: 'Note', name: 'note', value: entry?.note || '', span: true },
        ],
        danger: entry ? { label: 'Remove', onClick: () => store.remove('schedule', entry.id) } : null,
        onSubmit(v) {
          const tf = timeFields(v.startTime, v.endTime);
          if (!tf || !(tf.hours > 0)) { ui.toast('The end time has to be different from the start time', 'error'); return false; }
          const data = { jobId: v.jobId, employeeId: v.employeeId, date: v.date, note: v.note, ...tf };
          noteUse('jobs', v.jobId, { uid });
          noteUse('employees', v.employeeId, { uid });
          keep(TIMES_KEY, JSON.stringify({ startTime: tf.startTime, endTime: tf.endTime }));
          const commit = (rec) => {
            if (entry) store.update('schedule', entry.id, rec);
            else store.add('schedule', rec);
            addToCrew(rec.jobId, rec.employeeId);
            ui.toast('Schedule updated', 'success');
          };
          // Past-due hold at dispatch (r1-get-paid.md 4.5): assigning a held client's job needs "Dispatch anyway".
          const held = heldClient(data.jobId);
          if (held && !(entry?.holdAck && entry.jobId === data.jobId)) {
            ui.confirmDialog(`${held.name} is on hold for a past-due account. Check with the office before sending a crew.`, { title: 'Past due: hold work', okLabel: 'Dispatch anyway', danger: true })
              .then((ok) => { if (ok) commit({ ...data, holdAck: { by: auth.who().name, at: new Date().toISOString() } }); });
            return;
          }
          commit(data);
        },
      });

      // live hours, the next-day note and an overlap warning as the times change
      const form = sheet.el.querySelector('form');
      const val = (n) => form?.querySelector(`[name="${n}"]`)?.value || '';
      const update = () => {
        const s = val('startTime'), e = val('endTime');
        const mins = spanMinutes(s, e);
        readout.textContent = mins == null ? '—' : `${Math.round((mins / 60) * 100) / 100} h`;
        readout.classList.toggle('bad', mins === 0);
        const notes = [];
        if (mins === 0) notes.push('Pick an end time different from the start.');
        else if (isOvernight(s, e)) notes.push(`Ends the next day, ${shortDay(addDays(val('date') || ui.today(), 1))}.`);
        const clash = mins ? overlaps({ employeeId: val('employeeId'), date: val('date'), startTime: s, endTime: e }, entry?.id) : null;
        if (clash) notes.push(`Overlaps ${store.get('jobs', clash.jobId)?.number || 'another job'} ${rangeLabel(clash, hour12)}${clash.date !== val('date') ? ` on ${shortDay(clash.date)}` : ''}.`);
        readoutNote.textContent = notes.join(' ');
        readoutNote.classList.toggle('warn', !!clash);
      };
      form?.addEventListener('input', update);
      form?.addEventListener('change', update);
      update();
      return sheet;
    }

    /** Another shift of the same person that overlaps this one in time (including overnight ones), or null. */
    function overlaps(rec, ignoreId) {
      if (!rec.employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) return null;
      const t = entryTimes(rec);
      const base = new Date(rec.date + 'T00:00:00');
      const near = store.list('schedule', (s) => s.id !== ignoreId && s.employeeId === rec.employeeId && s.date >= addDays(rec.date, -1) && s.date <= addDays(rec.date, 1));
      return near.find((s) => {
        const x = entryTimes(s);
        const shift = Math.round((new Date(s.date + 'T00:00:00') - base) / 864e5) * 1440;
        return x.startMin + shift < t.endMin && x.endMin + shift > t.startMin;
      }) || null;
    }

    function addToCrew(jobId, employeeId) {
      const job = store.get('jobs', jobId);
      if (job && employeeId && !(job.crewIds || []).includes(employeeId)) store.update('jobs', job.id, { crewIds: [...(job.crewIds || []), employeeId] }, { silent: true });
    }

    /** The job's client when it is on a past-due or over-limit hold (no amounts: the flag only). */
    function heldClient(jobId) {
      const job = jobId ? store.get('jobs', jobId) : null;
      const client = job?.clientId ? store.get('clients', job.clientId) : null;
      return client?.credit?.hold?.on ? client : null;
    }

    function moveEntry(entry, { date, employeeId, delta }) {
      const patch = movePatch(entry, { date, employeeId }) || {};
      if (delta) {
        const shifted = shiftTimes(entry, delta);
        if (shifted.startTime !== entryTimes(entry).startTime) Object.assign(patch, shifted);
      }
      if (!Object.keys(patch).length) return;
      store.update('schedule', entry.id, patch);
      addToCrew(entry.jobId, patch.employeeId);
      const moved = { ...entry, ...patch };
      const parts = [patch.employeeId ? store.get('employees', patch.employeeId)?.name : null, patch.date ? shortDay(moved.date) : null, rangeLabel(moved, hour12)];
      ui.toast(`Moved: ${parts.filter(Boolean).join(', ')}`, 'success');
    }

    // ---------- drag to move (mouse drag, or long-press then drag on touch) ----------
    // A touch that moves before the long-press fires is a scroll and is left alone. Once dragging, the
    // chip's own non-passive touchmove listener stops the page panning, so pointer events keep coming.

    let press = null;
    let justDragged = 0;
    let redrawLater = false;

    function blockScroll(e) { if (press?.dragging) e.preventDefault(); }

    function draggable(el, entry, { timeline = false } = {}) {
      if (!canEdit) return el;
      el.classList.add('sched-draggable');
      el.addEventListener('pointerdown', (e) => {
        if (press || (e.pointerType === 'mouse' && e.button !== 0)) return;
        press = { el, entry, timeline, id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dragging: false, target: null };
        if (e.pointerType !== 'mouse') press.timer = setTimeout(beginDrag, LONG_PRESS_MS);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', endPress);
      });
      el.addEventListener('touchmove', blockScroll, { passive: false });
      el.addEventListener('contextmenu', (e) => { if (press) e.preventDefault(); });
      return el;
    }

    function beginDrag() {
      if (!press || press.dragging || !press.el.isConnected) return;
      press.dragging = true;
      const r = press.el.getBoundingClientRect();
      press.dx = press.x0 - r.left; press.dy = press.y0 - r.top;
      const g = press.el.cloneNode(true);
      g.classList.add('sched-ghost');
      g.setAttribute('aria-hidden', 'true');
      Object.assign(g.style, { left: '0px', top: '0px', width: `${r.width}px`, height: `${r.height}px` });
      cssVar(g, '--job', jobColor(press.entry.jobId));
      document.body.append(g);
      press.ghost = g;
      press.el.classList.add('sched-dragging-src');
      document.body.classList.add('sched-dragging');
      try { press.el.setPointerCapture?.(press.id); } catch { /* pointer already gone */ }
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
      place();
    }

    function onMove(e) {
      if (!press || e.pointerId !== press.id) return;
      press.x = e.clientX; press.y = e.clientY;
      if (!press.dragging) {
        const dist = Math.hypot(press.x - press.x0, press.y - press.y0);
        if (press.type === 'mouse' && dist > 5) beginDrag();
        else if (press.type !== 'mouse' && dist > 10) endPress(); // a scroll, not a long-press
        return;
      }
      e.preventDefault();
      place();
    }

    function place() {
      const p = press;
      p.ghost.style.transform = `translate(${p.x - p.dx}px, ${p.y - p.dy}px)`;
      const found = document.elementFromPoint(p.x, p.y)?.closest?.('[data-drop]');
      const hit = found && host.contains(found) ? found : null;
      if (hit !== p.target) { p.target?.classList.remove('sched-drop-on'); p.target = hit; hit?.classList.add('sched-drop-on'); }
      if (p.timeline) {
        const t = p.ghost.querySelector('.sched-bar-time');
        if (t) t.textContent = rangeLabel({ ...p.entry, ...shiftTimes(p.entry, timelineDelta(p)) }, hour12);
      }
      autoScroll(p);
    }

    /** Minutes a Day-view bar has been dragged sideways, snapped to 15. */
    function timelineDelta(p) {
      const track = p.el.closest('.sched-track');
      if (!track) return 0;
      const span = Number(track.dataset.to) - Number(track.dataset.from);
      const width = track.getBoundingClientRect().width || 1;
      return snapMinutes(((p.x - p.x0) / width) * span, 15);
    }

    function autoScroll(p) {
      const edge = 36;
      const side = p.el.closest('.sched-scroll');
      if (side) {
        const r = side.getBoundingClientRect();
        if (p.x < r.left + edge) side.scrollLeft -= 14; else if (p.x > r.right - edge) side.scrollLeft += 14;
      }
      const main = host.closest('.main');
      const scroller = main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
      if (!scroller) return;
      const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      if (p.y < box.top + edge) scroller.scrollTop -= 14; else if (p.y > box.bottom - edge) scroller.scrollTop += 14;
    }

    function onUp(e) {
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      if (!p.dragging) { endPress(); return; }
      justDragged = Date.now();
      const t = p.target;
      const delta = p.timeline ? timelineDelta(p) : 0;
      endPress();
      if (t) moveEntry(p.entry, { date: t.dataset.date, employeeId: t.dataset.employee, delta: p.timeline && t.dataset.date === p.entry.date ? delta : 0 });
    }

    function endPress() {
      const p = press;
      press = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', endPress);
      if (!p) return;
      clearTimeout(p.timer);
      if (p.dragging) {
        p.ghost?.remove();
        p.target?.classList.remove('sched-drop-on');
        p.el.classList.remove('sched-dragging-src');
        document.body.classList.remove('sched-dragging');
        try { p.el.releasePointerCapture?.(p.id); } catch { /* released */ }
      }
      if (redrawLater) { redrawLater = false; draw(); }
    }

    /** Chip tap: edit, unless the tap was the end of a drag. */
    const openChip = (s) => (e) => {
      e.stopPropagation();
      if (Date.now() - justDragged < 450) return;
      assign({}, s);
    };

    // ---------- shared pieces ----------

    function chip(s) {
      const job = store.get('jobs', s.jobId);
      const el = h('button', {
        type: 'button', class: 'sched-chip', title: `${jobLabel(job)} · ${rangeLabel(s, hour12)}${s.note ? ' — ' + s.note : ''}`,
        'aria-label': `${jobLabel(job)}, ${rangeLabel(s, hour12)}, ${hrs(s)}${canEdit ? '. Tap to edit, long-press to move.' : ''}`,
        onClick: openChip(s),
      },
      h('span', { class: 'sched-chip-top' }, h('span', { class: 'sched-chip-num' }, job?.number || '?'),
        heldClient(s.jobId) ? h('span', { class: 'sched-hold', title: 'Past due: hold work' }, ui.icon('alert', 12)) : null,
        h('span', { class: 'sched-chip-title' }, job?.title || 'Deleted job')),
      h('span', { class: 'sched-chip-time' }, h('span', null, rangeLabel(s, hour12)), h('span', { class: 'sched-chip-hrs' }, hrs(s))));
      cssVar(el, '--job', jobColor(s.jobId));
      return draggable(el, s);
    }

    const avatar = (p) => h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name));
    const personCell = (p, meta) => h('div', { class: 'sched-person', role: 'rowheader' }, avatar(p),
      h('div', { class: 'sched-person-text' }, h('div', { class: 'sched-person-name' }, p.name), h('div', { class: 'muted sched-small' }, meta ?? p.role ?? '')));

    /** Active crew plus anyone inactive who still has shifts showing, narrowed by the crew filter. */
    function crew(rows) {
      const list = activePeople();
      const have = new Set(list.map((p) => p.id));
      for (const s of rows) if (s.employeeId && !have.has(s.employeeId)) { const p = store.get('employees', s.employeeId); if (p) { list.push(p); have.add(p.id); } }
      return filters.employeeId ? list.filter((p) => p.id === filters.employeeId) : list;
    }

    const noCrew = () => ui.empty(filters.employeeId
      ? { icon: 'users', title: 'Nobody to show', text: 'That crew member is no longer active.', action: ui.button('All crew', { onClick: () => { filters.employeeId = ''; draw(); } }) }
      : { icon: 'users', title: 'No crew yet', text: 'Add employees to start scheduling.', action: ui.button('Employees', { href: '#/employees' }) });

    // ---------- Week ----------

    function weekView(range, rows, allRows) {
      const t = ui.today();
      const people = crew(rows);
      if (!people.length) return noCrew();
      const board = h('div', { class: 'sched-board sched-scroll', role: 'grid', 'aria-label': 'Crew schedule, week' },
        h('div', { class: 'sched-board-head', role: 'row' },
          h('div', { class: 'sched-board-corner' }, 'Crew'),
          range.days.map((d) => {
            const dayRows = rows.filter((s) => s.date === d);
            return h('button', { type: 'button', class: ['sched-board-day', d === t ? 'today' : null], role: 'columnheader', title: 'Open this day', onClick: () => go('day', d) },
              h('span', null, ui.fmtDate(d, { weekday: 'short' })), h('strong', null, ui.fmtDate(d, { day: 'numeric' })),
              h('span', { class: 'sched-small' }, dayRows.length ? `${new Set(dayRows.map((s) => s.employeeId)).size} crew · ${hoursLabel(totalHours(dayRows))}` : '—'));
          }),
          h('div', { class: 'sched-board-total' }, 'Week')),
        people.map((p) => {
          const mine = rows.filter((s) => s.employeeId === p.id);
          const total = totalHours(allRows.filter((s) => s.employeeId === p.id && s.date >= range.from));
          const shown = totalHours(mine);
          return h('div', { class: 'sched-board-row', role: 'row' },
            personCell(p),
            range.days.map((d) => {
              const cell = mine.filter((s) => s.date === d).sort((a, b) => entryTimes(a).startMin - entryTimes(b).startMin);
              return h('div', {
                class: ['sched-cell', d === t ? 'today' : null, canEdit ? 'editable' : null], role: 'gridcell', tabindex: canEdit ? 0 : null,
                dataset: { drop: '1', employee: p.id, date: d },
                'aria-label': `${p.name}, ${ui.fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })}${cell.length ? `, ${cell.length} assigned` : ', unassigned'}${canEdit ? '. Press Enter to assign.' : ''}`,
                onClick: () => assign({ employeeId: p.id, date: d }), onKeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) assign({ employeeId: p.id, date: d }); },
              }, cell.map(chip), canEdit ? h('span', { class: 'sched-cell-add', 'aria-hidden': 'true' }, ui.icon('plus', 14)) : null);
            }),
            h('div', { class: ['sched-board-total', total > 40 ? 'over' : null], title: filters.jobId ? 'All jobs this week' : null },
              hoursLabel(total), total > 40 ? h('span', { class: 'sched-small' }, 'over 40') : null,
              filters.jobId && shown !== total ? h('span', { class: 'sched-small muted' }, `${hoursLabel(shown)} here`) : null));
        }));

      // phones: one day at a time
      if (mobileDay < range.from || mobileDay > range.to) mobileDay = range.days.includes(t) ? t : range.from;
      const dayList = h('div', { class: 'sched-daylist' },
        ui.tabs(range.days.map((d) => ({ id: d, label: ui.fmtDate(d, { weekday: 'short', day: 'numeric' }) })), mobileDay, (d) => { mobileDay = d; draw(); }),
        h('div', { class: 'list sched-daylist-rows' }, people.map((p) => {
          const cell = rows.filter((s) => s.employeeId === p.id && s.date === mobileDay).sort((a, b) => entryTimes(a).startMin - entryTimes(b).startMin);
          return h('div', { class: 'list-row sched-daylist-row', dataset: { drop: '1', employee: p.id, date: mobileDay } },
            avatar(p),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name),
              cell.length ? h('div', { class: 'sched-chips' }, cell.map(chip)) : h('div', { class: 'meta' }, 'Not scheduled')),
            canEdit ? ui.button('', { icon: 'plus', size: 'sm', title: `Assign ${p.name}`, onClick: () => assign({ employeeId: p.id, date: mobileDay }) }) : null);
        })));
      return [board, dayList];
    }

    // ---------- Day ----------

    function dayView(day, rows) {
      const people = crew(rows);
      if (!people.length) return noCrew();
      const perPerson = people.map((p) => {
        const segs = daySegments(rows.filter((s) => s.employeeId === p.id), day);
        return { p, segs, lanes: assignLanes(segs) };
      });
      const win = dayWindow(perPerson.flatMap((x) => x.segs));
      const span = win.to - win.from;
      const pct = (m) => `${((m - win.from) / span) * 100}%`;
      const now = new Date();
      const nowMin = day === ui.today() ? now.getHours() * 60 + now.getMinutes() : -1;

      const track = (props, kids, lanes = 1) => {
        const el = h('div', { ...props, dataset: { from: String(win.from), to: String(win.to), ...(props.dataset || {}) } }, kids,
          nowMin >= win.from && nowMin <= win.to ? h('span', { class: 'sched-now', style: { left: pct(nowMin) }, 'aria-hidden': 'true' }) : null);
        cssVar(el, '--hours', String(span / 60));
        return cssVar(el, '--lanes', String(lanes));
      };

      const bar = (seg) => {
        const s = seg.entry;
        const job = store.get('jobs', s.jobId);
        const el = h('button', {
          type: 'button', class: ['sched-bar', seg.carried ? 'carried' : null, seg.continues ? 'continues' : null],
          style: { left: pct(seg.start), width: `${((seg.end - seg.start) / span) * 100}%` },
          title: `${jobLabel(job)} · ${rangeLabel(s, hour12)}${seg.carried ? ' (from the day before)' : ''}${s.note ? ' — ' + s.note : ''}`,
          'aria-label': `${jobLabel(job)}, ${rangeLabel(s, hour12)}${seg.carried ? ', started the day before' : ''}${canEdit ? '. Tap to edit' + (seg.carried ? '.' : ', long-press to move.') : ''}`,
          onClick: openChip(s),
        },
        h('span', { class: 'sched-bar-num' }, job?.number || '?'),
        heldClient(s.jobId) ? h('span', { class: 'sched-hold', title: 'Past due: hold work' }, ui.icon('alert', 12)) : null,
        h('span', { class: 'sched-bar-title' }, job?.title || 'Deleted job'),
        h('span', { class: 'sched-bar-time' }, rangeLabel(s, hour12)));
        cssVar(el, '--job', jobColor(s.jobId));
        cssVar(el, '--lane', String(seg.lane || 0));
        return seg.carried ? el : draggable(el, s, { timeline: true });
      };

      const tapTrack = (p) => (e) => {
        if (!canEdit || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const min = Math.min(win.to - 30, Math.max(win.from, snapMinutes(win.from + ((e.clientX - r.left) / (r.width || 1)) * span, 30)));
        assign({ employeeId: p.id, date: day, startTime: toTime(min) });
      };

      const hourMarks = Array.from({ length: span / 60 }, (_, i) => win.from + i * 60);
      return h('div', { class: 'sched-day sched-scroll', role: 'grid', 'aria-label': `Crew schedule, ${ui.fmtDate(day, { weekday: 'long', month: 'long', day: 'numeric' })}` },
        h('div', { class: 'sched-day-head', role: 'row' },
          h('div', { class: 'sched-day-corner' }, 'Crew'),
          track({ class: 'sched-track sched-axis', 'aria-hidden': 'true' }, hourMarks.map((m) => h('span', { class: 'sched-hour', style: { left: pct(m) } }, clockLabel(m, hour12))))),
        perPerson.map(({ p, segs, lanes }) => {
          const own = segs.filter((x) => !x.carried).map((x) => x.entry);
          return h('div', { class: 'sched-day-row', role: 'row' },
            personCell(p, own.length ? hoursLabel(totalHours(own)) : 'Not scheduled'),
            track({
              role: 'gridcell', class: ['sched-track', canEdit ? 'editable' : null], dataset: { drop: '1', employee: p.id, date: day },
              'aria-label': `${p.name}, ${own.length ? `${own.length} assigned` : 'not scheduled'}`, onClick: tapTrack(p),
            }, segs.map(bar), lanes));
        }));
    }

    // ---------- Month ----------

    function monthView(range, rows) {
      const t = ui.today();
      const month = anchor.slice(0, 7);
      return h('div', { class: 'sched-month', role: 'grid', 'aria-label': `Crew schedule, ${ui.fmtDate(anchor, { month: 'long', year: 'numeric' })}` },
        h('div', { class: 'sched-month-head', role: 'row' }, range.weeks[0].map((d) => h('div', { role: 'columnheader' }, ui.fmtDate(d, { weekday: 'short' })))),
        range.weeks.map((week) => h('div', { class: 'sched-month-row', role: 'row' }, week.map((d) => {
          const jobs = jobsOnDay(rows, d);
          const dayRows = rows.filter((s) => s.date === d);
          const crewCount = new Set(dayRows.map((s) => s.employeeId)).size;
          return h('button', {
            type: 'button', role: 'gridcell', class: ['sched-mday', d.slice(0, 7) !== month ? 'out' : null, d === t ? 'today' : null, jobs.length ? 'busy' : null],
            'aria-label': `${ui.fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}: ${jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}, ${crewCount} crew, ${hoursLabel(totalHours(dayRows))}` : 'nothing scheduled'}. Open the day.`,
            onClick: () => go('day', d),
          },
          h('span', { class: 'sched-mday-top' }, h('span', { class: 'sched-mday-num' }, ui.fmtDate(d, { day: 'numeric' })),
            crewCount ? h('span', { class: 'sched-mday-crew', title: `${crewCount} crew` }, ui.icon('users', 12), String(crewCount)) : null),
          h('span', { class: 'sched-mday-jobs' }, jobs.slice(0, 3).map((j) => {
            const job = store.get('jobs', j.jobId);
            return cssVar(h('span', { class: 'sched-mjob' }, h('span', { class: 'sched-mjob-dot' }),
              h('span', { class: 'sched-mjob-num' }, job?.number || '?'), h('span', { class: 'sched-mjob-n' }, `×${j.people}`)), '--job', jobColor(j.jobId));
          }), jobs.length > 3 ? h('span', { class: 'sched-mjob-more' }, `+${jobs.length - 3}`) : null));
        }))));
    }

    // ---------- toolbar ----------

    /** The day a new assignment or a switch to Day view starts on: today when it is in view, else the first day shown. */
    function pickDay(range) {
      const t = ui.today();
      if (view === 'day') return anchor;
      if (view === 'month') return t.slice(0, 7) === anchor.slice(0, 7) ? t : monthStart(anchor);
      if (isPhone() && mobileDay >= range.from && mobileDay <= range.to) return mobileDay;
      return range.days.includes(t) ? t : range.from;
    }

    function go(v, day) {
      view = v;
      if (day) { anchor = day; mobileDay = day; }
      draw();
    }

    function label(range) {
      if (view === 'day') return ui.fmtDate(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (view === 'month') return ui.fmtDate(anchor, { month: 'long', year: 'numeric' });
      return `${ui.fmtDate(range.from, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(range.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }

    function filterBar(range) {
      const jobs = activeJobs();
      if (filters.jobId && !jobs.find((j) => j.id === filters.jobId)) { const j = store.get('jobs', filters.jobId); if (j) jobs.unshift(j); }
      const sel = (name, all, items, value, onPick) => h('select', { class: 'input sched-filter', 'aria-label': name, onChange: (e) => onPick(e.target.value) },
        h('option', { value: '', selected: !value }, all), items.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
      const narrowed = filters.employeeId || filters.jobId !== focus;
      return h('div', { class: 'row sched-filters' },
        sel('Filter by crew member', 'All crew', rankByUse('employees', activePeople(), (p) => p.id, { uid }).map((p) => ({ value: p.id, label: p.name })), filters.employeeId,
          (v) => { filters.employeeId = v; if (v) noteUse('employees', v, { uid }); draw(); }),
        sel('Filter by job', 'All jobs', rankByUse('jobs', jobs, (j) => j.id, { uid }).map((j) => ({ value: j.id, label: jobLabel(j) })), filters.jobId,
          (v) => { filters.jobId = v; if (v) noteUse('jobs', v, { uid }); draw(); }),
        narrowed ? ui.button('Reset', { variant: 'ghost', size: 'sm', icon: 'x', title: 'Reset the filters', onClick: () => { filters.employeeId = ''; filters.jobId = focus; draw(); } }) : null,
        h('span', { class: 'grow' }),
        canEdit ? ui.button('Assign', { variant: 'primary', icon: 'plus', onClick: () => assign({ date: pickDay(range) }) }) : null);
    }

    function focusNote() {
      if (!focus || filters.jobId !== focus) return null;
      return h('div', { class: 'sched-focus', role: 'status' }, ui.icon('filter', 16),
        h('span', null, 'Showing ', h('strong', null, jobLabel(store.get('jobs', focus)))),
        h('span', { 'aria-hidden': 'true' }, '·'),
        h('button', { type: 'button', class: 'sched-link', onClick: () => { filters.jobId = ''; draw(); } }, 'Show all'));
    }

    const draw = () => {
      if (press?.dragging) { redrawLater = true; return; }
      if (press) endPress();
      ui.clear(host);
      const range = viewRange(view, anchor);
      // from the day before: overnight shifts reach into the first day shown
      const allRows = store.list('schedule', (s) => s.date >= addDays(range.from, -1) && s.date <= range.to);
      const rows = allRows.filter(entryFilter(filters));
      const inRange = rows.filter((s) => s.date >= range.from);

      const nav = h('div', { class: 'row sched-nav' },
        h('div', { class: 'row sched-step' },
          ui.button('', { icon: 'chevron-left', title: `Previous ${view}`, onClick: () => { anchor = stepAnchor(view, anchor, -1); draw(); } }),
          ui.button('Today', { onClick: () => { anchor = ui.today(); mobileDay = anchor; draw(); } }),
          ui.button('', { icon: 'chevron-right', title: `Next ${view}`, onClick: () => { anchor = stepAnchor(view, anchor, 1); draw(); } })),
        h('strong', { class: 'sched-label', 'aria-live': 'polite' }, label(range)),
        h('span', { class: 'grow' }),
        h('div', { class: 'tabs sched-views', role: 'tablist', 'aria-label': 'Schedule view' }, [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([id, text]) =>
          h('button', { type: 'button', role: 'tab', 'aria-selected': String(view === id), onClick: () => {
            keep(VIEW_KEY, id);
            if (id !== view) go(id, id === 'day' ? pickDay(range) : null);
          } }, text))));

      const body = view === 'day' ? dayView(anchor, rows) : view === 'month' ? monthView(range, inRange) : weekView(range, inRange, allRows);
      const subtitle = view === 'day' ? 'Who is where, hour by hour' : view === 'month' ? 'The month at a glance. Tap a day to open it.' : 'Who is where this week';
      const tip = !canEdit || view === 'month' ? null
        : view === 'day' ? 'Tap an empty time to assign. Drag a bar, or long-press it on a touch screen, to move it to another person or time.'
          : 'Tap an empty slot to assign. Drag a chip, or long-press it on a touch screen, to move it to another day or person.';
      host.append(ui.page({ title: 'Schedule', subtitle, actions: [] }, nav, filterBar(range), focusNote(),
        tip ? h('p', { class: 'muted sched-small sched-tip' }, tip) : null, body));
    };

    root.append(host);
    draw();
    const offs = ['schedule', 'employees', 'jobs', 'clients'].map((c) => store.on(c, draw));
    offs.push(onJobFocus(() => { focus = jobFocus(store, auth); filters.jobId = focus; draw(); }));
    return () => {
      offs.forEach((f) => f());
      redrawLater = false;
      endPress();
    };
  },
};
