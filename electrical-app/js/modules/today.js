// My day (#/today): every worker's tasks for today in order, tomorrow's once it is published,
// and what is still open from before. Start, finish (photo-required tasks open the camera
// first), log progress, or flag "blocked" with a reason the foreman sees. Everything is a
// store write, so it works offline and syncs later. Managers also get the crew's day and a
// quick "Add task" for anyone. The rules live in js/lib/workplan.js (shared with the API).
import * as W from '../lib/workplan.js';

// Clipboard with a check (24px grid, stroke): the rail icon for My day.
export const ICON_TODAY = '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>';
const ICON_CAMERA = '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
const ICON_BLOCK = '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>';

export default {
  id: 'today',
  title: 'My day',
  icon: ICON_TODAY,
  group: 'home',
  perm: 'today',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    const me = auth.current();
    const empId = me.id || null;
    const manager = auth.isManager();
    let view = ctx.query.view === 'crew' && manager ? 'crew' : 'mine';
    const open = new Set(); // expanded cards
    const host = h('div');
    const syncLine = h('div', { class: 'wp-syncline muted', role: 'status' });

    const jobs = () => new Map(store.list('jobs').map((j) => [j.id, j]));
    // My tasks that matter today: anything open, plus finished ones from this week (photos are
    // heavy, so older finished work stays out of memory).
    const myTasks = () => { const since = W.addDays(ui.today(), -7); return store.list('workTasks', (t) => t.employeeId === empId && (t.status !== 'done' || (t.date || '') >= since)); };

    function paintSync(s) {
      const n = s?.waiting || 0;
      ui.clear(syncLine).append(n ? `${n} update${n === 1 ? '' : 's'} saved on this device; ${s.state === 'offline' ? "they'll sync when you're back online" : 'syncing'}.` : '');
    }

    // ---------- actions ----------
    const now = () => new Date().toISOString();
    const by = () => empId || me.id || null;
    const save = (t, patch, summary) => store.update('workTasks', t.id, patch, summary ? { summary } : undefined);
    const fresh = (t) => store.get('workTasks', t.id) || t;
    const markSeen = (t) => { if (!t.seenAt) save(t, { seenAt: now() }); };

    function start(t) {
      save(t, W.startTask(fresh(t), { now: now(), by: by() }), `started ${t.title}`);
      ui.toast('Started', 'success');
    }

    async function finish(t0) {
      let t = fresh(t0);
      const need = W.photosNeeded(t) - (t.photos || []).filter((p) => p?.dataUrl).length;
      if (need > 0 && !t.evidenceWaived) {
        // The camera opens straight from the tap (a file input needs the user's gesture).
        const shots = await capturePhotos(ui, { count: need });
        if (!shots.length) { ui.toast(need === 1 ? 'Take the photo to finish this task.' : `Take ${need} photos to finish this task.`, 'error', 3500); return; }
        t = save(t, { photos: [...(fresh(t).photos || []), ...shots].slice(0, W.MAX_PHOTOS), seenAt: t.seenAt || now(), progressAt: now(), progressBy: by() }, `photo for ${t.title}`);
        const still = W.evidenceProblem(t);
        if (still) { ui.toast(still, 'error', 4000); return; }
      }
      completeSheet(t);
    }

    function completeSheet(t) {
      const elapsed = t.startedAt ? Math.round(((Date.now() - Date.parse(t.startedAt)) / 3_600_000) * 4) / 4 : null;
      const hours = t.actualHours ?? (elapsed && elapsed <= 14 ? elapsed : t.estHours) ?? '';
      ui.formSheet({
        title: `Finish: ${t.title}`,
        submitLabel: 'Mark done',
        fields: [
          { label: 'Hours spent', name: 'actualHours', type: 'number', step: '0.25', min: '0', max: '24', value: hours, hint: t.estHours ? `Planned ${t.estHours} h` : null },
          t.qty != null ? { label: `Quantity done${t.unit ? ` (${t.unit})` : ''}`, name: 'qtyDone', type: 'number', step: 'any', min: '0', value: t.qtyDone ?? t.qty, hint: `Planned ${t.qty}` } : null,
          { label: 'Note (optional)', name: 'note', type: 'textarea', rows: 2, value: t.note || '', span: true },
        ].filter(Boolean),
        extra: (t.photos || []).length ? photoStrip(ui, t.photos) : null,
        onSubmit(v) {
          const r = W.completeTask(fresh(t), { now: now(), by: by(), actualHours: v.actualHours, qtyDone: v.qtyDone, note: v.note });
          if (r.error) { ui.toast(r.error, 'error', 4000); return false; }
          save(t, r.patch, `completed ${t.title}`);
          ui.toast('Done. Nice work.', 'success');
        },
      });
    }

    function progressSheet(t) {
      ui.formSheet({
        title: `Progress: ${t.title}`,
        submitLabel: 'Save progress',
        fields: [
          t.qty != null ? { label: `Quantity done so far${t.unit ? ` (${t.unit})` : ''}`, name: 'qtyDone', type: 'number', step: 'any', min: '0', value: t.qtyDone ?? '', hint: `Of ${t.qty}` } : null,
          { label: 'Hours so far', name: 'actualHours', type: 'number', step: '0.25', min: '0', max: '24', value: t.actualHours ?? '' },
          { label: 'Note', name: 'note', type: 'textarea', rows: 3, value: t.note || '', span: true },
        ].filter(Boolean),
        extra: h('div', { class: 'row' }, ui.button('Add a photo', { icon: ICON_CAMERA, onClick: () => addPhoto(t) })),
        onSubmit(v) {
          const cur = fresh(t);
          const patch = { note: String(v.note || '').slice(0, 4000), progressAt: now(), progressBy: by(), seenAt: cur.seenAt || now() };
          if (v.qtyDone != null) patch.qtyDone = Math.max(0, v.qtyDone);
          if (v.actualHours != null) patch.actualHours = Math.max(0, v.actualHours);
          if (cur.status === 'todo') Object.assign(patch, W.startTask(cur, { now: now(), by: by() }));
          save(t, patch, `progress on ${t.title}`);
          ui.toast('Progress saved', 'success');
        },
      });
    }

    async function addPhoto(t) {
      if ((fresh(t).photos || []).length >= W.MAX_PHOTOS) return ui.toast(`Up to ${W.MAX_PHOTOS} photos per task`, 'error');
      const shots = await capturePhotos(ui, { count: 1 });
      if (!shots.length) return;
      const cur = fresh(t);
      save(t, { photos: [...(cur.photos || []), ...shots].slice(0, W.MAX_PHOTOS), progressAt: now(), progressBy: by(), seenAt: cur.seenAt || now() }, `photo for ${t.title}`);
      ui.toast('Photo saved with the task', 'success');
    }

    function blockSheet(t) {
      let reason = W.BLOCK_REASONS[0];
      const note = h('textarea', { class: 'input', rows: 3, placeholder: 'What do you need? (optional)', 'aria-label': 'Details' });
      const choices = h('div', { class: 'wp-reasons', role: 'radiogroup', 'aria-label': 'Reason' });
      const paint = () => {
        ui.clear(choices);
        for (const r of W.BLOCK_REASONS) {
          choices.append(h('button', { type: 'button', class: ['wp-reason', r === reason ? 'on' : null], role: 'radio', 'aria-checked': String(r === reason), onClick: () => { reason = r; paint(); } }, r));
        }
      };
      paint();
      const s = ui.openSheet({
        title: `Blocked: ${t.title}`,
        body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Your foreman sees this as soon as it syncs.'), choices, h('label', { class: 'field' }, h('span', null, 'Details'), note)),
        actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Mark blocked', { variant: 'danger solid', icon: ICON_BLOCK, onClick: () => {
          save(t, W.blockTask(fresh(t), reason, { now: now(), by: by(), note: note.value }), `blocked: ${reason}`);
          s.close();
          ui.toast('Marked blocked. Your foreman will see it.', 'info', 3500);
        } })],
      });
    }

    function resume(t) {
      save(t, W.unblockTask(fresh(t), { now: now(), by: by() }), `unblocked ${t.title}`);
      ui.toast('Back on it', 'success');
    }

    async function undo(t) {
      if (!(await ui.confirmDialog(`Put "${t.title}" back to in progress?`, { title: 'Not done yet?', okLabel: 'Not done', danger: false }))) return;
      save(t, W.undoComplete(fresh(t), { now: now(), by: by() }), `undid completion of ${t.title}`);
    }

    function gotIt(list) {
      const at = now();
      for (const t of list) if (!t.ackAt) save(t, { ackAt: at, ackVia: 'self', seenAt: t.seenAt || at });
      store.log('ack', `${me.name} acknowledged ${list.length} task${list.length === 1 ? '' : 's'}`, 'workTasks');
      ui.toast('Got it. Have a good day.', 'success');
    }

    // ---------- cards ----------
    function card(t, { readOnly = false, jobById, all = [] } = {}) {
      const job = jobById.get(t.jobId);
      const need = W.photosNeeded(t);
      const have = (t.photos || []).length;
      const isOpen = open.has(t.id);
      const waiting = W.waitingOn(t, all);
      const openBlock = (t.blocks || []).filter((b) => !b.resolvedAt).at(-1);
      const pct = t.qty > 0 && t.qtyDone != null ? Math.min(100, Math.round((100 * t.qtyDone) / t.qty)) : null;
      const big = (label, opts) => ui.button(label, { size: 'lg', ...opts });
      const actions = readOnly ? null : h('div', { class: 'wp-actions' },
        t.status === 'todo' ? [big('Start', { variant: 'primary', icon: 'play', onClick: () => start(t) }), big('Done', { icon: need > have ? ICON_CAMERA : 'check', onClick: () => finish(t) })] : null,
        t.status === 'in-progress' ? [big('Done', { variant: 'primary', icon: need > have ? ICON_CAMERA : 'check', onClick: () => finish(t) }), big('Progress', { icon: 'edit', onClick: () => progressSheet(t) })] : null,
        t.status === 'blocked' ? big('Resume', { variant: 'primary', icon: 'play', onClick: () => resume(t) }) : null,
        t.status === 'done' ? big('Not done', { variant: 'ghost', icon: 'undo', onClick: () => undo(t) }) : null,
        ['todo', 'in-progress'].includes(t.status) ? big('Blocked', { variant: 'ghost danger', icon: ICON_BLOCK, onClick: () => blockSheet(t) }) : null);
      const toggle = () => { if (open.has(t.id)) open.delete(t.id); else { open.add(t.id); markSeen(t); } draw(); };
      return h('article', { class: ['wp-card', `is-${t.status}`, W.isNew(t) ? 'is-new' : null], dataset: { task: t.id } },
        h('div', { class: 'wp-card-main', role: 'button', tabindex: 0, 'aria-expanded': String(isOpen), onClick: toggle, onKeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } } },
          h('div', { class: 'wp-card-top' },
            W.isNew(t) ? ui.badge('New', 'accent') : null,
            t.priority === 'high' ? ui.badge('Priority', 'danger') : null,
            t.status === 'done' ? ui.badge(`Done ${ui.fmtTime(t.completedAt)}`, 'success') : t.status !== 'todo' ? ui.statusBadge(t.status) : null,
            need ? h('span', { class: ['wp-photo-flag', have >= need ? 'ok' : null], title: 'Photo evidence required' }, ui.icon(ICON_CAMERA, 16), have >= need ? `${have} photo${have === 1 ? '' : 's'}` : need === 1 ? 'Photo required' : `${need} photos required`) : null),
          h('h3', { class: 'wp-card-title' }, t.title || 'Untitled task'),
          h('div', { class: 'wp-card-meta' }, [job ? job.number : null, t.phaseName || null, t.qty != null ? `${ui.fmtNum(t.qty, t.qty % 1 ? 2 : 0)} ${t.unit || ''}`.trim() : null, t.estHours ? `${t.estHours} h` : null].filter(Boolean).join(' · ')),
          pct != null && t.status !== 'done' ? h('div', { class: 'wp-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Quantity done' }, h('span', { style: { width: `${pct}%` } })) : null,
          openBlock ? h('div', { class: 'wp-blocked-why' }, ui.icon(ICON_BLOCK, 14), ` ${openBlock.reason}${openBlock.note ? `: ${openBlock.note}` : ''}`) : null,
          waiting.length ? h('div', { class: 'wp-waiting muted' }, `Waiting on: ${waiting.map((x) => x.title).join(', ')}`) : null),
        isOpen ? h('div', { class: 'wp-card-more' },
          t.description ? h('p', { class: 'wp-desc' }, t.description) : null,
          job ? h('div', { class: 'muted' }, `${job.number} · ${job.title}${job.address ? ` · ${job.address}` : ''}`) : null,
          linkButton(ui, t),
          t.note ? h('p', { class: 'wp-note' }, h('strong', null, 'Note: '), t.note) : null,
          (t.photos || []).length ? photoStrip(ui, t.photos) : null,
          !readOnly && t.status !== 'done' ? h('div', { class: 'row' }, ui.button('Add a photo', { size: 'sm', icon: ICON_CAMERA, onClick: () => addPhoto(t) }), t.status === 'todo' ? ui.button('Log progress', { size: 'sm', icon: 'edit', onClick: () => progressSheet(t) }) : null) : null) : null,
        actions);
    }

    // ---------- views ----------
    function mine() {
      const day = ui.today();
      const all = myTasks();
      const jobById = jobs();
      const todays = W.tasksFor(all, empId, day);
      const carried = W.carriedOver(all, empId, day);
      const upcoming = [...new Set(all.filter((t) => t.date > day && W.isPublished(t)).map((t) => t.date))].sort();
      const next = upcoming[0] || null;
      const nextTasks = next ? W.tasksFor(all, empId, next) : [];
      const done = todays.filter((t) => t.status === 'done').length;
      const hours = todays.reduce((s, t) => s + (Number(t.estHours) || 0), 0);
      const unacked = todays.filter((t) => !t.ackAt && t.status !== 'done');
      const nextLabel = next === W.addDays(day, 1) ? 'Tomorrow' : next ? ui.fmtDate(next, { weekday: 'long', month: 'short', day: 'numeric' }) : 'Tomorrow';
      return [
        todays.length ? h('div', { class: 'wp-dayhead' },
          h('div', { class: 'wp-dayhead-count' }, h('strong', { class: 'num' }, `${done}/${todays.length}`), h('span', { class: 'muted' }, ' done')),
          h('div', { class: 'wp-dayhead-bar', role: 'progressbar', 'aria-valuenow': done, 'aria-valuemin': 0, 'aria-valuemax': todays.length, 'aria-label': 'Tasks done today' }, h('span', { style: { width: `${todays.length ? (100 * done) / todays.length : 0}%` } })),
          h('span', { class: 'muted' }, `${Math.round(hours * 100) / 100} h planned`)) : null,
        unacked.length ? h('div', { class: 'wp-ack card' },
          h('div', { class: 'grow' }, h('strong', null, "Today's list is ready"), h('div', { class: 'muted' }, `${unacked.length} task${unacked.length === 1 ? '' : 's'}. Tap "Got it" once you've read them.`)),
          ui.button('Got it', { variant: 'primary', size: 'lg', icon: 'check', onClick: () => gotIt(unacked) })) : null,
        carried.length ? [h('h2', { class: 'section' }, 'Still open from earlier'), h('div', { class: 'wp-cards' }, carried.map((t) => card(t, { jobById, all })))] : null,
        todays.length
          ? h('div', { class: 'wp-cards' }, todays.map((t) => card(t, { jobById, all })))
          : ui.empty({ icon: ICON_TODAY, title: 'Nothing on your list today', text: empId ? 'Your foreman publishes the day\'s tasks the evening before or at the morning meeting. They show up here when your device syncs.' : 'Your account is not linked to an employee record yet, so it has no tasks. Ask an owner or admin to link it.' }),
        h('h2', { class: 'section' }, nextLabel),
        nextTasks.length
          ? h('div', { class: 'wp-cards wp-preview' }, nextTasks.map((t) => card(t, { readOnly: true, jobById, all })))
          : h('p', { class: 'muted' }, `${nextLabel}'s list isn't out yet.`),
      ];
    }

    function crew() {
      const day = ui.today();
      const tomorrow = W.nextWorkDay(day);
      const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
      const tasks = store.list('workTasks', (t) => t.date === day && W.isPublished(t), { omit: ['photos'] });
      const jobById = jobs();
      return [
        h('div', { class: 'row', style: { marginBottom: 'var(--s3)' } },
          h('span', { class: 'muted grow' }, `Everyone's published tasks for ${ui.fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' })}.`),
          ui.button('Add a task', { variant: 'primary', icon: 'plus', onClick: () => quickTaskSheet(ctx, { day, tomorrow }) })),
        h('div', { class: 'wp-crew' }, people.map((p) => {
          const mineToday = W.sortTasks(tasks.filter((t) => t.employeeId === p.id));
          const done = mineToday.filter((t) => t.status === 'done').length;
          const blocked = mineToday.filter((t) => t.status === 'blocked').length;
          return h('div', { class: 'card wp-crew-card' },
            h('div', { class: 'row' },
              h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)),
              h('div', { class: 'grow' }, h('div', { style: { fontWeight: 650 } }, p.name), h('div', { class: 'muted wp-small' }, mineToday.length ? `${done}/${mineToday.length} done${blocked ? ` · ${blocked} blocked` : ''}${mineToday.some((t) => t.ackAt) ? ' · got it' : ''}` : 'No tasks today')),
              ui.button('', { icon: 'plus', size: 'sm', title: `Add a task for ${p.name}`, onClick: () => quickTaskSheet(ctx, { day, tomorrow, employeeId: p.id }) })),
            mineToday.length ? h('ul', { class: 'wp-mini' }, mineToday.map((t) => h('li', { class: `is-${t.status}` },
              h('span', { class: 'wp-dot', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, t.title), jobById.get(t.jobId) ? h('span', { class: 'muted wp-small' }, jobById.get(t.jobId).number) : null,
              t.status === 'blocked' ? ui.badge('blocked', 'danger') : null))) : null);
        })),
      ];
    }

    const draw = () => {
      const subtitle = ui.fmtDate(ui.today(), { weekday: 'long', month: 'long', day: 'numeric' });
      ui.clear(host).append(ui.page({
        title: view === 'crew' ? "Crew's day" : 'My day',
        subtitle,
        actions: [
          manager && auth.can('workplan') ? ui.button('Work plans', { icon: 'calendar', href: '#/workplan' }) : null,
        ].filter(Boolean),
      },
      manager ? h('div', { style: { marginBottom: 'var(--s4)' } }, ui.tabs([{ id: 'mine', label: 'My tasks' }, { id: 'crew', label: 'Crew today' }], view, (id) => { view = id; draw(); })) : null,
      syncLine,
      view === 'crew' ? crew() : mine()));
    };

    root.append(host);
    draw();
    paintSync(ctx.app?.sync?.status?.());
    let pending = null;
    const later = () => { clearTimeout(pending); pending = setTimeout(draw, 40); };
    const offs = [
      store.on('workTasks', (e) => {
        // A task added to my list from elsewhere (the foreman, after the day was published).
        if (e.remote && e.type === 'add' && e.record?.employeeId === empId && W.isNew(e.record)) ui.toast(`New task: ${e.record.title}`, 'info', 4000);
        later();
      }),
      store.on('jobs', later),
      store.on('employees', later),
      ctx.app?.onSyncStatus?.(paintSync) || (() => {}),
    ];
    return () => { clearTimeout(pending); offs.forEach((f) => f()); };
  },
};

// ---------- shared with the work-plan screens ----------

/** "Open drawing" / "Open wire run" / an external link, or null. */
export function linkButton(ui, t) {
  const l = t?.link;
  if (!l?.kind) return null;
  if (l.kind === 'drawing' && l.id) return ui.button(l.label || 'Open drawing', { size: 'sm', icon: 'pen', href: `#/drawings/${encodeURIComponent(l.id)}` });
  if (l.kind === 'wireRun' && l.id) return ui.button(l.label || 'Open wire run', { size: 'sm', icon: 'ruler', href: `#/wireruns/${encodeURIComponent(l.id)}` });
  if (l.kind === 'url' && /^https?:\/\//.test(l.url || '')) return ui.h('a', { class: 'btn secondary sm', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, ui.icon('link', 16), ui.h('span', null, l.label || 'Open link'));
  return null;
}

export function photoStrip(ui, photos) {
  return ui.h('div', { class: 'wp-photos' }, (photos || []).filter((p) => p?.dataUrl).map((p, i) =>
    ui.h('a', { href: p.dataUrl, target: '_blank', rel: 'noopener', class: 'wp-photo', title: p.takenAt ? ui.fmtDateTime(p.takenAt) : `Photo ${i + 1}` },
      ui.h('img', { src: p.dataUrl, alt: `Evidence photo ${i + 1}`, loading: 'lazy' }))));
}

/**
 * Open the camera (rear camera on phones and iPads) and return downscaled JPEG photos:
 * [{ id, dataUrl, takenAt, width, height }]. Resolves [] when cancelled. Must be called
 * straight from a tap: the file input needs the user's gesture.
 */
export function capturePhotos(ui, { count = 1 } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    if (count > 1) input.multiple = true;
    input.className = 'wp-file';
    let settled = false;
    const done = async (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      const out = [];
      for (const f of files.slice(0, Math.max(1, count))) {
        try { out.push(await downscalePhoto(f)); } catch (e) { console.error(e); ui.toast(`Couldn't read that photo`, 'error'); }
      }
      resolve(out);
    };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

const approxBytes = (dataUrl) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Downscale a photo to a JPEG data URL under PHOTO_MAX_BYTES (longest side PHOTO_MAX_SIDE). */
export async function downscalePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = W.PHOTO_MAX_SIDE, q = 0.72, out = null, w = 0, hgt = 0;
    for (let i = 0; i < 10; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.max(1, Math.round(img.naturalWidth * k));
      hgt = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, hgt);
      g.drawImage(img, 0, 0, w, hgt);
      out = c.toDataURL('image/jpeg', q);
      if (approxBytes(out) <= W.PHOTO_MAX_BYTES) break;
      if (q > 0.5) q -= 0.1; else side = Math.round(side * 0.8);
    }
    return { id: crypto.randomUUID?.() || `ph-${Date.now().toString(36)}`, dataUrl: out, takenAt: new Date().toISOString(), width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Quick "add a task to someone's list" (My day's crew view, the meeting screen). Without a
 * plan the task goes out at once; on a plan, a published day gets it at once with a "new"
 * badge, and an unpublished day keeps it as a draft until the day is published.
 * @param {{ day: string, tomorrow?: string, employeeId?: string, planId?: string, jobId?: string, onSaved?: Function }} o
 */
export function quickTaskSheet(ctx, { day, tomorrow, employeeId = '', planId = '', jobId = '', onSaved } = {}) {
  const { store, ui, auth } = ctx;
  const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const jobsList = store.list('jobs', (j) => ['scheduled', 'in-progress', 'on-hold'].includes(j.status) || j.id === jobId).sort((a, b) => String(a.number).localeCompare(String(b.number)));
  const plans = store.list('workPlans', (p) => p.status !== 'archived');
  const templates = store.list('taskTemplates').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const defaultPlan = planId || (jobId ? plans.find((p) => p.jobId === jobId)?.id : '') || '';
  ui.formSheet({
    title: 'Add a task',
    submitLabel: 'Add task',
    fields: [
      templates.length ? { label: 'From a template', name: 'templateId', type: 'select', value: '', span: true, options: [{ value: '', label: '— none —' }, ...templates.map((t) => ({ value: t.id, label: t.name || t.title }))] } : null,
      { label: 'Task', name: 'title', required: true, span: true, placeholder: 'e.g. Pull home runs to panel B' },
      { label: 'Who', name: 'employeeId', type: 'select', value: employeeId, required: true, options: [{ value: '', label: 'Pick someone' }, ...people.map((p) => ({ value: p.id, label: p.name }))] },
      { label: 'Day', name: 'date', type: 'select', value: day, options: [{ value: day, label: `Today (${ui.fmtDate(day, { weekday: 'short' })})` }, ...(tomorrow ? [{ value: tomorrow, label: `${tomorrow === W.addDays(day, 1) ? 'Tomorrow' : 'Next working day'} (${ui.fmtDate(tomorrow, { weekday: 'short' })})` }] : [])] },
      { label: 'Job', name: 'jobId', type: 'select', value: jobId || store.get('workPlans', defaultPlan)?.jobId || '', options: ui.recordOptions(jobsList, (j) => `${j.number} · ${j.title}`, 'No job') },
      plans.length ? { label: 'Work plan', name: 'planId', type: 'select', value: defaultPlan, options: [{ value: '', label: 'Not on a plan' }, ...plans.map((p) => ({ value: p.id, label: p.name || store.get('jobs', p.jobId)?.title || 'Plan' }))] } : null,
      { label: 'Hours', name: 'estHours', type: 'number', step: '0.25', min: '0', max: '24', value: 1 },
      { label: 'Quantity', name: 'qty', type: 'number', step: 'any', min: '0', value: '' },
      { label: 'Unit', name: 'unit', placeholder: 'boxes, m, runs…', value: '' },
      { label: 'Priority', name: 'priority', type: 'select', value: 'normal', options: W.PRIORITIES.map((p) => ({ value: p, label: p })) },
      { label: 'Needs a photo to finish', name: 'requiresPhoto', type: 'checkbox', value: false, span: true },
      { label: 'Details', name: 'description', type: 'textarea', rows: 2, value: '', span: true },
    ].filter(Boolean),
    onSubmit(v) {
      if (!v.employeeId) { ui.toast('Pick who the task is for', 'error'); return false; }
      const tpl = v.templateId ? store.get('taskTemplates', v.templateId) : null;
      const plan = v.planId ? store.get('workPlans', v.planId) : null;
      const now = new Date().toISOString();
      const by = auth.current().id || null;
      const base = tpl ? W.fromTemplate(tpl) : W.newTask();
      const order = store.count('workTasks', (t) => t.employeeId === v.employeeId && t.date === v.date) + 1;
      const t = store.add('workTasks', {
        ...base,
        title: v.title || base.title, description: v.description || base.description, employeeId: v.employeeId, date: v.date,
        jobId: v.jobId || plan?.jobId || null, planId: plan?.id || null, estHours: Number(v.estHours) || base.estHours || 0,
        qty: v.qty == null ? base.qty : Number(v.qty), unit: v.unit || base.unit, priority: v.priority || 'normal',
        requiresPhoto: v.requiresPhoto || base.requiresPhoto, order, createdBy: by,
        ...W.placement(plan, v.date, { now, by, adHoc: !plan }),
      });
      const who = store.get('employees', v.employeeId)?.name || 'them';
      ui.toast(t.status === 'draft' ? `Added as a draft for ${who}: publish ${ui.fmtDate(v.date, { weekday: 'long' })} to send it` : `Added to ${who}'s list. It shows on their next sync.`, 'success', 3500);
      onSaved?.(t);
    },
  });
}
