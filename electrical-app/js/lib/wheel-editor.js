// The shortcut editor — add any module as a shortcut, tick which show, order them with the arrows.
// Shared chrome, but each surface keeps its OWN list via `scope` (lib/wheel.js prefs, per person, on
// this device): scope 'wheel' = the radial + menu (edited in Settings), scope 'home' = the Today home's
// Quick actions tiles (edited from the home). Editing one never changes the other. Every change
// dispatches a scope-tagged 'ft:wheel-changed' so only the matching surface rebuilds.
import { WHEEL, wheelPrefs, saveWheelPrefs, resetWheelPrefs, orderWheel, addedShortcuts, moduleShortcut } from './wheel.js';

/**
 * Render the wheel shortcut editor into `host`. Re-renders itself in place on each change. Returns
 * { draw } so the caller can force a redraw.
 * @param {HTMLElement} host
 * @param {{ ui: object, auth?: object, on?: Function, modules?: Array, store?: object, showCompanyToggle?: boolean, scope?: string }} deps
 *   - ui: the shared UI helpers (h, icon, button, openSheet, toast, clear)
 *   - auth: current()/can() for the signed-in person (optional; permissive without it)
 *   - on: module-enabled check (go/id -> boolean); permissive without it
 *   - modules: the nav module registry, for the "add a shortcut" catalogue
 *   - store: needed only when showCompanyToggle is true (company-wide wheel on/off)
 *   - showCompanyToggle: include the "show the + wheel" company switch (Settings only)
 *   - scope: which list to edit — 'wheel' (the + radial, default) or 'home' (the Today Quick actions)
 */
export function renderWheelEditor(host, { ui, auth, on, modules = [], store = null, showCompanyToggle = false, scope = 'wheel' }) {
  const { h } = ui;

  const draw = () => {
    ui.clear(host);
    const uid = auth?.current?.()?.id || null;
    const prefs = wheelPrefs(uid, scope);
    const can = (p) => !p || (auth?.can ? auth.can(p) : true);
    const enabled = (go) => (on ? on(String(go).split(/[/?]/)[0]) : true);
    // the defaults plus the shortcuts this person added; gated like the rail
    const pool = [...WHEEL, ...addedShortcuts(prefs)].filter((w) => can(w.perm) && enabled(w.go));
    const shown = orderWheel(pool, prefs);
    const shownIds = shown.map((w) => w.id);
    const hiddenItems = pool.filter((w) => !shownIds.includes(w.id));
    // every module you can open that isn't already a shortcut — the "add" catalogue
    const bases = new Set(pool.map((w) => String(w.go).split(/[/?]/)[0]));
    const addable = modules.filter((m) => !m.hidden && m.group !== 'home' && can(m.perm) && enabled(m.id) && !bases.has(m.id))
      .map(moduleShortcut).sort((a, b) => a.label.localeCompare(b.label));
    const isAdded = (w) => String(w.id).startsWith('mod:');
    // Keep the scroll where it is: re-rendering collapses/regrows host, which would otherwise yank the
    // page (or sheet) to the top and make a toggle look like it did nothing.
    const commit = (next) => {
      const sc = host.closest('.sheet-body, .main'); const top = sc ? sc.scrollTop : 0;
      saveWheelPrefs(uid, next, scope); dispatchEvent(new CustomEvent('ft:wheel-changed', { detail: { scope } })); draw();
      if (sc) sc.scrollTop = top;
    };
    const setShown = (id, show) => {
      const hidden = new Set(prefs.hidden || []);
      const order = Array.isArray(prefs.order) ? [...prefs.order] : [...shownIds];
      if (show) { hidden.delete(id); if (!order.includes(id)) order.push(id); } else hidden.add(id);
      commit({ ...prefs, hidden: [...hidden], order });
    };
    const move = (id, dir) => {
      const order = [...shownIds];
      const i = order.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      commit({ ...prefs, order });
    };
    const addShortcut = (item) => {
      if (pool.some((w) => w.id === item.id)) return;
      const order = Array.isArray(prefs.order) ? [...prefs.order] : [...shownIds];
      if (!order.includes(item.id)) order.push(item.id);
      commit({ ...prefs, added: [...addedShortcuts(prefs), item], order, hidden: (prefs.hidden || []).filter((x) => x !== item.id) });
      ui.toast(`${item.label} added`, 'success');
    };
    const removeAdded = (id) => commit({ ...prefs, added: addedShortcuts(prefs).filter((a) => a.id !== id), order: (prefs.order || []).filter((x) => x !== id), hidden: (prefs.hidden || []).filter((x) => x !== id) });
    const addSheet = () => {
      if (!addable.length) { ui.toast('Every module you can open is already a shortcut', 'info'); return; }
      const s = ui.openSheet({
        title: 'Add a shortcut',
        body: h('div', { class: 'list' }, addable.map((m) => h('button', { type: 'button', class: 'list-row click', onClick: () => { s.close(); addShortcut(m); } },
          ui.icon(m.icon, 18), h('span', { class: 'grow', style: { textAlign: 'left' } }, m.label), ui.icon('plus', 16)))),
        actions: [ui.button('Close', { variant: 'ghost', onClick: () => s.close() })],
      });
    };
    const row = (w, i, show) => h('div', { class: ['wheel-pref-row', show ? null : 'off'], dataset: { wheel: w.id } },
      ui.icon(w.icon, 18),
      h('span', { class: 'grow' }, w.label),
      show ? h('span', { class: 'row wheel-pref-move' },
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'chevron-up', title: `Move ${w.label} earlier`, disabled: i === 0, onClick: () => move(w.id, -1) }),
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'chevron-down', title: `Move ${w.label} later`, disabled: i === shown.length - 1, onClick: () => move(w.id, 1) })) : null,
      isAdded(w) ? ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: `Remove ${w.label}`, onClick: () => removeAdded(w.id) }) : null,
      h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: show, 'aria-label': `Show ${w.label}`, onChange: (e) => setShown(w.id, e.target.checked) }));

    const parts = [];
    if (showCompanyToggle && store) {
      parts.push(h('label', { class: 'field check' },
        h('input', { type: 'checkbox', checked: store.settings()?.ui?.showWheel !== false,
          onChange: (e) => { store.saveSettings({ ui: { ...(store.settings().ui || {}), showWheel: e.target.checked } }); ui.toast(e.target.checked ? 'Quick-actions wheel on' : 'Quick-actions wheel hidden', 'success'); } }),
        h('span', null, 'Show the quick-actions wheel (the + button and radial menu)')));
    }
    parts.push(
      h('div', { class: 'muted' }, `${scope === 'home' ? 'The Today home’s Quick actions tiles' : 'The + button’s radial menu'} — just for you, on this device. Add any module as a shortcut, tick which show, and order them with the arrows. The + wheel and the home are separate lists.`),
      h('div', { class: 'list wheel-pref-list' },
        shown.length ? shown.map((w, i) => row(w, i, true)) : h('div', { class: 'list-row muted' }, 'No shortcuts shown — add or tick some below.'),
        hiddenItems.map((w) => row(w, -1, false))),
      h('div', { class: 'row' }, ui.button('Add shortcut', { variant: 'secondary', icon: 'plus', onClick: addSheet }), h('span', { class: 'grow' }),
        ui.button('Reset to default', { variant: 'ghost', icon: 'undo', onClick: () => {
          const sc = host.closest('.sheet-body, .main'); const top = sc ? sc.scrollTop : 0;
          resetWheelPrefs(uid, scope); dispatchEvent(new CustomEvent('ft:wheel-changed', { detail: { scope } })); draw();
          if (sc) sc.scrollTop = top; ui.toast('Shortcuts reset', 'success');
        } })));
    host.append(...parts);
  };

  draw();
  return { draw };
}
