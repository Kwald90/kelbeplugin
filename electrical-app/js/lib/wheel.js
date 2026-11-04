// The quick-actions wheel (the radial + menu): the list of shortcuts, and each person's own
// choice of which to show and in what order. The choice is per user and lives on this device
// (localStorage, keyed by user id) — it does not sync to the server. app.js builds the live wheel
// from WHEEL + orderWheel(); the Settings page edits the same prefs and then dispatches
// 'ft:wheel-changed' so the shell rebuilds the wheel.

// `run` names a handler app.js supplies by id (see WHEEL_RUN there); without one the item navigates
// to `go`. `perm` gates the item against the signed-in person's permissions.
export const WHEEL = [
  { id: 'clock', label: 'Clock', icon: 'clock', go: 'time', perm: 'time' },
  { id: 'draw', label: 'Draw', icon: 'pen', go: 'drawings/new', perm: 'drawings' },
  { id: 'lead', label: 'Lead', icon: 'funnel', go: 'leads?new=1', perm: 'leads' },
  { id: 'quote', label: 'Quote', icon: 'file-text', go: 'estimates/new', perm: 'estimates' },
  { id: 'job', label: 'Job', icon: 'briefcase', go: 'jobs?new=1', perm: 'jobs' },
  { id: 'material', label: 'Material', icon: 'truck', go: 'materials?new=1', perm: 'jobs' },
  { id: 'receipt', label: 'Receipt', icon: 'image', go: 'purchasing', perm: 'invoices', run: 'quickReceipt' },
  { id: 'invoice', label: 'Invoice', icon: 'receipt', go: 'invoices/new', perm: 'invoices' },
  { id: 'calc', label: 'Calc', icon: 'calculator', go: 'calcs', perm: 'calcs' },
  { id: 'sops', label: 'SOPs', icon: 'book', go: 'sops', perm: 'sops' },
];

/** A wheel shortcut built from a nav module (so any module can be added to the wheel). */
export function moduleShortcut(m) {
  return { id: `mod:${m.id}`, label: m.title, icon: m.icon || 'grid', go: m.id, perm: m.perm };
}

/** The extra shortcuts this person added beyond the defaults: validated [{ id, label, icon, go, perm }]. */
export function addedShortcuts(prefs = {}) {
  const list = Array.isArray(prefs.added) ? prefs.added : [];
  return list.filter((s) => s && typeof s.id === 'string' && typeof s.go === 'string' && typeof s.label === 'string' && typeof s.icon === 'string');
}

const key = (uid) => `kc.wheel.${uid || 'local'}`;

/** This person's wheel prefs: { hidden: [id], order: [id] }. Missing/blocked storage → {} (defaults). */
export function wheelPrefs(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(key(uid)) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

export function saveWheelPrefs(uid, prefs) {
  try { localStorage.setItem(key(uid), JSON.stringify(prefs || {})); } catch { /* storage blocked */ }
}

export function resetWheelPrefs(uid) {
  try { localStorage.removeItem(key(uid)); } catch { /* ignore */ }
}

/**
 * Apply a person's prefs to an already permission-filtered list: drop the ones they hid, then put the
 * rest in their chosen order. Anything not in `order` (a shortcut shipped after they last customised)
 * keeps its WHEEL order and falls in after the ones they placed, so new shortcuts appear by default.
 */
export function orderWheel(items, prefs = {}) {
  const hidden = new Set(prefs.hidden || []);
  const order = Array.isArray(prefs.order) ? prefs.order : [];
  const rank = (id) => {
    const i = order.indexOf(id);
    return i >= 0 ? i : order.length + items.findIndex((x) => x.id === id);
  };
  return items.filter((w) => !hidden.has(w.id)).sort((a, b) => rank(a.id) - rank(b.id));
}
