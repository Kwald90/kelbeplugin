// The "Working on" controls (lib/job-focus.js holds the rules):
//   workingOnPicker(ctx)        the dropdown on the home screens (Today dashboard, My day)
//   focusChip(ctx)              the app-wide "Working on: 1234 · Smith reno ✕" pill the shell shows
//   openFocusSheet(ctx)         pick or clear the job (the pill opens it)
//   focusNote(ctx, jobId, fn)   "Showing 1234 · Smith reno · Show all" above a list opened on the focus
import { jobFocus, setJobFocus, onJobFocus, focusChoices, noteJobUse, jobLabel } from './job-focus.js';

/** Shortcuts the home screens offer for the focused job: [module id, permission, label, icon, href]. */
const JOB_SHORTCUTS = [
  ['drawings', 'drawings', 'Plans & drawings', 'pen', '#/drawings'],
  ['materials', 'jobs', 'Material request', 'truck', '#/materials'],
  ['dailylog', 'jobs', 'Daily log', 'book', '#/dailylog'],
  ['walkthroughs', 'jobs', 'Photos & walkthroughs', 'image', '#/walkthroughs'],
  ['punchlist', 'jobs', 'Punch list', 'list', '#/punchlist'],
  ['time', 'time', 'Time', 'clock', '#/time'],
  ['rfis', 'jobs', 'RFIs', 'info', '#/rfis'],
];

/** Change the focus, count the use, and say what happened. */
export function chooseFocus(ctx, jobId) {
  const { store, auth, ui } = ctx;
  const before = jobFocus(store, auth);
  const id = setJobFocus(store, auth, jobId);
  if (id) noteJobUse(id);
  if (id === before) return id;
  const job = id ? store.get('jobs', id) : null;
  ui.toast(job ? `Working on ${jobLabel(job)}. Screens open on this job.` : 'Showing all jobs', 'success', 3000);
  return id;
}

const visibleJobs = (ctx) => ctx.store.list('jobs');

/** The "Working on" dropdown for the home screens. Re-renders itself when the focus changes. */
export function workingOnPicker(ctx, { shortcuts = true } = {}) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const host = h('section', { class: 'focus-picker', 'aria-label': 'Working on' });
  // A shortcut shows when the person may open the screen and the company has it turned on.
  const can = (id, perm) => auth.can(perm) && (!ctx.on || ctx.on(id));
  const paint = () => {
    const focus = jobFocus(store, auth);
    const choices = focusChoices(visibleJobs(ctx));
    const select = h('select', {
      class: 'input focus-picker-select', id: 'focus-picker-select', 'aria-describedby': 'focus-picker-hint',
      onChange: (e) => chooseFocus(ctx, e.target.value),
    }, choices.map((c) => h('option', { value: c.value, selected: c.value === focus }, c.label)));
    const job = focus ? store.get('jobs', focus) : null;
    h(ui.clear(host), null,
      h('div', { class: 'focus-picker-row' },
        h('label', { class: 'focus-picker-label', for: 'focus-picker-select' }, ui.icon('briefcase', 18), 'Working on'),
        select,
        job ? ui.button('', { variant: 'ghost', icon: 'x', title: 'Show all jobs', onClick: () => chooseFocus(ctx, '') }) : null),
      h('p', { class: 'focus-picker-hint', id: 'focus-picker-hint' }, job
        ? 'Plans, material requests, logs, photos and time open on this job, and new ones are saved to it.'
        : 'All jobs: each screen shows everything and asks which job. Pick one to set the app up for it.'),
      job && shortcuts ? h('div', { class: 'focus-shortcuts' }, JOB_SHORTCUTS.filter(([id, perm]) => can(id, perm)).map(([, , label, glyph, href]) =>
        h('a', { class: 'focus-shortcut', href }, ui.icon(glyph, 18), h('span', null, label)))) : null);
  };
  paint();
  const off = onJobFocus(() => { if (host.isConnected) paint(); else off(); });
  host.refresh = paint; // jobs added or closed out: the screen redraws and calls this
  return host;
}

/** A sheet listing All jobs + the open jobs (most-used first) with a search box. */
export function openFocusSheet(ctx) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const focus = jobFocus(store, auth);
  const jobs = new Map(visibleJobs(ctx).map((j) => [j.id, j]));
  const choices = focusChoices([...jobs.values()]);
  const list = h('div', { class: 'list focus-sheet-list', role: 'listbox', 'aria-label': 'Jobs' });
  let needle = '';
  const draw = () => {
    ui.clear(list);
    const shown = choices.filter((c) => !c.value || !needle || `${c.label} ${jobs.get(c.value)?.address || ''}`.toLowerCase().includes(needle));
    for (const c of shown) {
      const job = jobs.get(c.value);
      list.append(h('button', {
        type: 'button', class: ['list-row', 'click', 'focus-sheet-row'], role: 'option', 'aria-selected': String(c.value === focus),
        onClick: () => { chooseFocus(ctx, c.value); sheet.close(); },
      }, ui.icon(c.value ? 'briefcase' : 'layers', 18),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, c.label), job?.address ? h('span', { class: 'meta' }, job.address) : null),
      c.value === focus ? ui.icon('check', 18) : null));
    }
    if (shown.length === 1 && needle) list.append(h('p', { class: 'muted focus-sheet-empty' }, 'No open job matches.'));
  };
  draw();
  const search = choices.length > 8 ? h('input', { type: 'search', class: 'input', placeholder: 'Find a job…', 'aria-label': 'Find a job', onInput: (e) => { needle = e.target.value.trim().toLowerCase(); draw(); } }) : null;
  const sheet = ui.openSheet({
    title: 'Working on',
    initialFocus: search ? 'input[type=search]' : '[aria-selected="true"]',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Pick a job and the app opens on it everywhere on this device. All jobs puts things back.'),
      search, list),
  });
  return sheet;
}

/** The app-wide pill. Shows only while a job is focused; repaints itself on every change. */
export function focusChip(ctx) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const chip = h('div', { class: 'focus-chip no-print', hidden: true });
  const paint = () => {
    const job = store.get('jobs', jobFocus(store, auth));
    chip.hidden = !job;
    ui.clear(chip);
    if (!job) return;
    chip.append(
      h('button', { type: 'button', class: 'focus-chip-main', 'aria-label': `Working on ${jobLabel(job)}. Change job`, onClick: () => openFocusSheet(ctx) },
        ui.icon('briefcase', 16), h('span', { class: 'focus-chip-kicker' }, 'Working on'), h('span', { class: 'focus-chip-job' }, jobLabel(job))),
      h('button', { type: 'button', class: 'focus-chip-x', 'aria-label': 'Show all jobs', title: 'Show all jobs', onClick: () => chooseFocus(ctx, '') }, ui.icon('x', 16)));
  };
  paint();
  const off = onJobFocus(paint);
  // A job closed out or deleted (here or by sync) stops being the focus: jobFocus reads it as ''.
  const offStore = store.on('jobs', paint);
  return { el: chip, paint, destroy: () => { off(); offStore(); chip.remove(); } };
}

/**
 * "Showing 1234 · Smith reno · Show all" for a list opened on the focused job. Null when the list
 * isn't showing the focused job (the person picked another job, or All, in the screen's own filter).
 */
export function focusNote(ctx, jobId, onShowAll) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const focus = jobFocus(store, auth);
  if (!focus || jobId !== focus) return null;
  const job = store.get('jobs', focus);
  if (!job) return null;
  return h('div', { class: 'focus-note', role: 'status' },
    ui.icon('filter', 16),
    h('span', { class: 'grow' }, 'Showing ', h('strong', null, jobLabel(job))),
    h('button', { type: 'button', class: 'btn sm ghost focus-note-all', onClick: onShowAll }, 'Show all'));
}
