// Shared helpers for the Safety screens (modules/safety.js and its sub-views).

export const ICON_HARDHAT = '<path d="M3 17h18v2H3z"/><path d="M5 17a7 7 0 0114 0"/><path d="M10 10V6h4v4"/>';
export const ICON_STOP = '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M8 12h8"/>';

/** The person using the app as { id (employee id or null), name, role }. */
export function me(ctx) {
  const c = ctx.auth.current();
  return { id: c.id || null, name: c.name || 'Me', role: c.role };
}

export const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '');
export const nameOf = (store, id, fallback = '—') => (id ? store.get('employees', id)?.name || fallback : fallback);

export function jobOptions(ctx, blank = '— no job —') {
  const jobs = ctx.store.list('jobs').sort((a, b) => String(a.number || '').localeCompare(String(b.number || '')));
  return ctx.ui.recordOptions(jobs, jobLabel, blank);
}

export function employeeOptions(ctx, blank = '— nobody —') {
  return ctx.ui.recordOptions(ctx.store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name)), 'name', blank);
}

/**
 * Jobs a worker is on today: scheduled, clocked in, or on the crew of an active job that
 * spans today. Most specific first.
 */
export function todaysJobs(store, employeeId, day) {
  const ids = new Set();
  if (employeeId) {
    for (const s of store.list('schedule', (x) => x.employeeId === employeeId && x.date === day)) if (s.jobId) ids.add(s.jobId);
    for (const t of store.list('timeEntries', (x) => x.employeeId === employeeId && x.clockIn && String(x.clockIn).slice(0, 10) <= day)) {
      if (t.jobId && (!t.clockOut || String(t.clockIn).slice(0, 10) === day)) ids.add(t.jobId);
    }
    for (const j of store.list('jobs', (x) => (x.crewIds || []).includes(employeeId) && ['scheduled', 'in-progress'].includes(x.status)
      && (!x.startDate || x.startDate <= day) && (!x.endDate || x.endDate >= day))) ids.add(j.id);
  }
  return [...ids].map((id) => store.get('jobs', id)).filter(Boolean);
}

/** A segmented control: seg([[value, label]], current, onChange, { label }) */
export function seg(ui, options, value, onChange, { label = '', cls = '' } = {}) {
  const { h } = ui;
  const host = h('div', { class: ['seg', 'sf-seg', cls], role: 'radiogroup', 'aria-label': label });
  const draw = (v) => {
    ui.clear(host);
    for (const [val, text] of options) {
      host.append(h('button', { type: 'button', role: 'radio', class: ['seg-btn', val], 'aria-checked': String(v === val),
        onClick: () => { draw(val); onChange(val); } }, text));
    }
  };
  draw(value);
  return host;
}

/** Toggle chips for a set of ids: chips(ui, [[id, label]], selectedSet, onChange) */
export function chips(ui, options, selected, onChange, label = '') {
  const { h } = ui;
  const host = h('div', { class: 'sf-chips', role: 'group', 'aria-label': label });
  for (const [id, text] of options) {
    const b = h('button', { type: 'button', class: 'sf-chip', 'aria-pressed': String(selected.has(id)),
      onClick: () => { if (selected.has(id)) selected.delete(id); else selected.add(id); b.setAttribute('aria-pressed', String(selected.has(id))); onChange?.(); } }, text);
    host.append(b);
  }
  return host;
}

/** A stored signature as an image with name and time. */
export function signatureView(ui, sig, label = 'Signed') {
  const { h } = ui;
  if (!sig?.dataUrl) return h('span', { class: 'muted' }, 'Not signed');
  return h('figure', { class: 'sf-sig-view' }, h('img', { src: sig.dataUrl, alt: `${label} by ${sig.name || ''}` }),
    h('figcaption', { class: 'muted' }, `${label}${sig.name ? ` by ${sig.name}` : ''} · ${ui.fmtDateTime(sig.at)}`));
}

export const backBtn = (ui, href, title = 'Back') => ui.button('', { icon: 'chevron-left', title, href });

/**
 * NOTIFY HOOK (safety alerts). There is no server notify() helper yet, so alerts are an
 * audit entry on the device and a toast. When the server grows notify(), call it from the
 * sync path for: stop-work FLHAs, new incidents, reportable incidents, overdue actions.
 * See docs/safety/README.md "Notifications".
 */
export function notifySafety(ctx, event, summary, recordId = null) {
  try { ctx.store.log(`safety-${event}`, summary, 'safety', recordId); } catch { /* ignore */ }
}

export function emptyNoEmployee(ui) {
  return ui.empty({ icon: 'user', title: 'Link your account to an employee', text: 'Safety records are filed in a worker\'s name. Ask an owner to link your login to your employee record.' });
}
