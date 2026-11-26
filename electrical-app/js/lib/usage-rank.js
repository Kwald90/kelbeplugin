// Usage ranking: lists put the things a person uses most at the top and the rest below, in their
// normal order. Every pick-list, button grid and menu in the app should go through this.
//
// Counts are the person's own, on this device (localStorage keyed by user), one bucket per list
// ('calcs', 'bending', 'materials.items', 'jobs'…). Recent use counts for more than old use: each
// count halves after HALF_LIFE_DAYS, so last month's favourite fades if it stops being used.
//
//   import { noteUse, rankByUse } from '../lib/usage-rank.js';
//   const ordered = rankByUse('calcs', CALCS, (c) => c.id, { uid });
//   button.onclick = () => { noteUse('calcs', c.id, { uid }); open(c); };
//
// The shell calls setUsageUser(id) when someone signs in, so screens may leave `uid` out.

export const HALF_LIFE_DAYS = 30;
const MAX_KEYS = 300; // per list; the least-used fall off so storage stays small
const DAY = 86400000;
let defaultUid = '';
const key = (list, uid) => `ft.usage.${uid || defaultUid || 'local'}.${list}`;
const storage = (opts) => { if (opts?.storage) return opts.storage; try { return globalThis.localStorage || null; } catch { return null; } };

/** Whose counts calls without opts.uid read and write (the signed-in person). */
export function setUsageUser(uid) { defaultUid = uid ? String(uid) : ''; }

/** { id: { n, t } } for a list: n = decayed count as of t (ms). */
export function readUsage(list, opts = {}) {
  try {
    const v = JSON.parse(storage(opts)?.getItem(key(list, opts.uid)) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Decayed score of one entry at time `now`. */
export function score(entry, now = Date.now()) {
  if (!entry || !(entry.n > 0)) return 0;
  const ageDays = Math.max(0, (now - (entry.t || now)) / DAY);
  return entry.n * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Record one use of `id` in `list`. */
export function noteUse(list, id, opts = {}) {
  if (id == null || id === '') return;
  const now = opts.now ?? Date.now();
  const all = readUsage(list, opts);
  const k = String(id);
  all[k] = { n: score(all[k], now) + 1, t: now };
  let entries = Object.entries(all);
  if (entries.length > MAX_KEYS) {
    entries = entries.sort((a, b) => score(b[1], now) - score(a[1], now)).slice(0, MAX_KEYS);
  }
  try { storage(opts)?.setItem(key(list, opts.uid), JSON.stringify(Object.fromEntries(entries))); } catch { /* storage blocked */ }
}

/**
 * Items sorted most-used first. Items never used (or used too little to matter) keep their original
 * relative order after the used ones, so a fresh install looks exactly like the designed order.
 * opts.limit: only the top `limit` used items move up (e.g. a "Frequent" row); the rest stay put.
 */
export function rankByUse(list, items, idOf = (x) => x?.id, opts = {}) {
  const now = opts.now ?? Date.now();
  const usage = readUsage(list, opts);
  const rows = (items || []).map((item, i) => ({ item, i, s: score(usage[String(idOf(item))], now) }));
  const used = rows.filter((r) => r.s >= 0.05).sort((a, b) => b.s - a.s || a.i - b.i);
  const top = opts.limit ? used.slice(0, opts.limit) : used;
  const topSet = new Set(top);
  return [...top, ...rows.filter((r) => !topSet.has(r))].map((r) => r.item);
}

/** { id: decayed score } for a list, for screens that blend usage into their own ordering. */
export function usageScores(list, opts = {}) {
  const now = opts.now ?? Date.now();
  return Object.fromEntries(Object.entries(readUsage(list, opts)).map(([id, e]) => [id, score(e, now)]));
}

/** The most-used ids in a list (for a "Frequent" strip), highest first. */
export function topUsed(list, n = 5, opts = {}) {
  const now = opts.now ?? Date.now();
  return Object.entries(readUsage(list, opts))
    .map(([id, e]) => [id, score(e, now)])
    .filter(([, s]) => s >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

export function resetUsage(list, opts = {}) {
  try { storage(opts)?.removeItem(key(list, opts.uid)); } catch { /* ignore */ }
}

/**
 * Pick-list options most-used first, with the blank / "none" choices (value '') kept at the top.
 * options: [{ value, label }] or plain strings.
 */
export function rankOptions(list, options, opts = {}) {
  const valueOf = (o) => (o && typeof o === 'object' ? o.value : o);
  const pinned = (options || []).filter((o) => valueOf(o) === '' || valueOf(o) == null);
  const rest = (options || []).filter((o) => !(valueOf(o) === '' || valueOf(o) == null));
  return [...pinned, ...rankByUse(list, rest, valueOf, opts)];
}
