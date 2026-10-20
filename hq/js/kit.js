// Small helpers shared by the finance, invoicing, developer, AI, settings, users,
// announcements, help and audit pages.

/** A body that shows Loading…, then whatever `draw` builds, or the error. */
export function loader(ui, host, fn) {
  const { h } = ui;
  ui.clear(host);
  host.append(h('p', { class: 'muted' }, 'Loading…'));
  return Promise.resolve().then(fn).catch((e) => {
    ui.clear(host);
    host.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message, action: ui.button('Try again', { onClick: () => loader(ui, host, fn) }) }));
  });
}

export const kv = (ui, pairs) => ui.h('dl', { class: 'hq-kv' }, pairs.filter(Boolean).map(([k, v]) => [ui.h('dt', null, k), ui.h('dd', null, v ?? '—')]));

export const card = (ui, title, icon, ...kids) => ui.h('div', { class: 'card' }, ui.h('h3', null, icon ? ui.icon(icon, 18) : null, title), ...kids);

export const banner = (ui, tone, title, text) => ui.h('div', { class: ['hq-banner', tone] }, ui.icon(tone === 'ok' ? 'check' : 'alert', 20),
  ui.h('div', null, ui.h('strong', null, title), text ? ui.h('span', { class: 'hq-small' }, text) : null));

/** US dollars (AI spend is estimated in US cents). */
export const usd = (cents) => `US$${((Number(cents) || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A key that makes a money action safe to retry (one per dialog). */
export const requestKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Download a CSV (or any text) from an HQ endpoint with the session cookie. */
export async function downloadFrom(ui, path, filename) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/csv' } });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  ui.download(filename, await res.text(), 'text/csv');
}

/** Local day bounds as ISO times, for "from"/"to" date inputs. */
export function dayStart(yyyyMmDd, plusDays = 0) {
  if (!yyyyMmDd) return undefined;
  const d = new Date(`${yyyyMmDd}T00:00:00`);
  d.setDate(d.getDate() + plusDays);
  return d.toISOString();
}

/** A labelled control for toolbars. */
export const labelled = (ui, label, control, cls) => ui.h('label', { class: ['field', 'hq-filter', cls] }, ui.h('span', null, label), control);
