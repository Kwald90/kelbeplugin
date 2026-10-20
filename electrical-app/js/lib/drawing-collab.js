// Collaborative drawings: who drew what, the change history and the per-object merge.
// Pure helpers (no DOM), shared by the canvas editor (canvas/collab.js) and the API
// (server/src/auth/access.js merges drawing writes with mergeDrawing).
//
// Attribution lives on each item (stroke, object/symbol, text, room):
//   by { id, name }   who created it          at      when (ISO)
//   editBy { id, name } who last changed it   editAt  when
// Items from before tracking have none of these and show as "Before tracking".
//
// The editor never stamps items while you draw: on each save it compares the drawing with
// the last saved state (a baseline of content keys) and stamps what changed, so pointer
// handling stays untouched. The same diff becomes a compact history entry (symbol counts
// per person and save, folded while the same person keeps working) instead of a copy of the
// drawing. Deleted items leave a tombstone { at, by } so a merge knows they were deleted
// rather than never seen.
import { SYMBOLS } from '../canvas/symbols.js';

export const ITEM_KINDS = ['strokes', 'objects', 'texts', 'rooms'];
const STAMP_KEYS = new Set(['by', 'at', 'editBy', 'editAt']);
/** History entries kept per drawing (oldest dropped first). */
export const HISTORY_MAX = 400;
/** Tombstones kept per drawing; old ones only matter to a device that was offline a long time. */
export const TOMBSTONE_MAX = 3000;
/** One person's saves within this long of their last entry fold into it. */
export const FOLD_MS = 15 * 60 * 1000;
/** Item ids an entry remembers (for "tap to zoom" and to cancel add-then-delete). */
const ENTRY_IDS_MAX = 80;
export const BEFORE_TRACKING = 'Before tracking';
export const UNTRACKED_ID = '__untracked';

// ---------- small helpers ----------

/** Key-order-independent JSON. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** An item's content without its attribution stamps. */
export function contentKey(item) {
  const o = {};
  for (const k of Object.keys(item || {})) if (!STAMP_KEYS.has(k)) o[k] = item[k];
  return canon(o);
}

/** Who did something: { id, name }, trimmed. */
export function person(p) {
  return { id: p?.id == null ? null : String(p.id).slice(0, 128), name: String(p?.name || 'Someone').trim().slice(0, 80) || 'Someone' };
}

/** Last time an item was created or changed ('' before tracking). */
export const itemTime = (it) => it?.editAt || it?.at || '';
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
/** `now`, or just after `prev` when another device's clock put `prev` ahead of ours. */
function after(now, prev) {
  return prev && ms(prev) >= ms(now) ? new Date(ms(prev) + 1).toISOString() : now;
}

/** What an item is, for counting: a symbol id, or '@wire' '@mark' '@measure' '@text' '@room'. */
export function tagOf(kind, it) {
  if (kind === 'objects') return it.symbol === 'receptacle' && it.flags?.gfci ? 'receptacle-gfci' : (it.symbol || '@object');
  if (kind === 'strokes') return it.tool === 'wire' ? '@wire' : it.tool === 'measure' ? '@measure' : '@mark';
  return kind === 'texts' ? '@text' : '@room';
}

/** Rough world bounds of an item, [x0, y0, x1, y1] (no DOM; good enough to zoom to). */
export function itemBox(kind, it) {
  if (kind === 'objects' || kind === 'texts') {
    const x = Number(it.x) || 0, y = Number(it.y) || 0;
    if (kind === 'objects') { const r = 17 * (Number(it.scale) || 1); return [x - r, y - r, x + r, y + r]; }
    const size = Number(it.size) || 18;
    const lines = String(it.text ?? '').split('\n');
    return [x, y, x + Math.max(...lines.map((l) => l.length)) * size * 0.6, y + lines.length * size * 1.25];
  }
  const pts = it.points || [];
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}

const growBox = (a, b) => (!b ? a : !a ? [...b] : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

// ---------- baseline and stamping ----------

/**
 * The stroke a piece belongs to: the area eraser cuts a stroke into pieces, the first keeping
 * its id and the rest carrying splitFrom (canvas/erase.js). They count as one item in the history.
 */
const familyOf = (it) => it?.splitFrom || it?.id;

/** What the editor compares the next save against: id -> { kind, key, time, tag, box, pos, family }. */
export function baselineOf(d) {
  const m = new Map();
  for (const kind of ITEM_KINDS) {
    for (const it of d?.[kind] || []) {
      if (!it?.id) continue;
      m.set(it.id, { kind, key: contentKey(it), time: itemTime(it), tag: tagOf(kind, it), box: itemBox(kind, it), pos: kind === 'objects' || kind === 'texts' ? [it.x, it.y] : null, family: familyOf(it) });
    }
  }
  return m;
}

/**
 * Stamp what changed since `baseline` and record deletions as tombstones. Mutates `d`'s items
 * and `d.tombstones`. Returns the diff ({ add, del, move, edit } lists of { id, kind, tag, box })
 * and the new baseline.
 * @param {object} d drawing (strokes, objects, texts, rooms, tombstones)
 * @param {Map} baseline from baselineOf() at the last save
 * @param {{ id: string|null, name: string }} who
 * @param {string} now ISO time
 */
export function stampChanges(d, baseline, who, now = new Date().toISOString()) {
  const by = person(who);
  const diff = { add: [], del: [], move: [], edit: [] };
  const seen = new Set();
  d.tombstones ||= {};
  // Pieces of one stroke cut by the area eraser (familyOf) count once per list: cutting a line
  // in two is one edit of it, not an edit plus a new mark.
  const present = new Set(), before = new Set();
  for (const kind of ITEM_KINDS) for (const it of d[kind] || []) if (it?.id) present.add(familyOf(it));
  for (const b of baseline.values()) before.add(b.family ?? null);
  const once = (list) => {
    const m = new Map();
    return (fam, entry) => {
      const e = m.get(fam);
      if (e) e.box = growBox(e.box, entry.box);
      else { const x = { ...entry, id: fam }; m.set(fam, x); diff[list].push(x); }
    };
  };
  const addOnce = once('add'), editOnce = once('edit'), delOnce = once('del');
  for (const kind of ITEM_KINDS) {
    for (const it of d[kind] || []) {
      if (!it?.id) continue;
      seen.add(it.id);
      const b = baseline.get(it.id);
      const entry = { id: it.id, kind, tag: tagOf(kind, it), box: itemBox(kind, it) };
      if (!b && it.splitFrom && before.has(it.splitFrom)) {
        // a piece the eraser cut from a stroke that was already here: it keeps that stroke's
        // author (copied onto it); whoever erased made the edit
        delete d.tombstones[it.id];
        it.editBy = by;
        it.editAt = after(now, itemTime(it));
        editOnce(it.splitFrom, entry);
        continue;
      }
      if (!b) {
        if (d.tombstones[it.id] && it.by) {
          // undo brought back a deleted item: it keeps its author, and its edit time passes
          // the tombstone's so a merge keeps it
          const t = d.tombstones[it.id];
          delete d.tombstones[it.id];
          it.editBy = by;
          it.editAt = after(now, ms(t?.at) > ms(itemTime(it)) ? t.at : itemTime(it));
        } else {
          // new here (drawn, placed, duplicated or auto-placed): this person made it
          const t = d.tombstones[it.id];
          delete d.tombstones[it.id];
          it.by = by; it.at = after(now, t?.at);
          delete it.editBy; delete it.editAt;
        }
        addOnce(familyOf(it), entry);
      } else {
        const key = contentKey(it);
        if (key === b.key) continue;
        it.editBy = by;
        it.editAt = after(now, b.time);
        const moved = b.pos && contentKey({ ...it, x: b.pos[0], y: b.pos[1] }) === b.key;
        if (moved) diff.move.push({ ...entry, box: growBox(entry.box, b.box) });
        else editOnce(familyOf(it), { ...entry, box: growBox(entry.box, b.box) });
      }
    }
  }
  for (const [id, b] of baseline) {
    if (seen.has(id)) continue;
    d.tombstones[id] = { at: after(now, b.time), by: by.id };
    const gone = { id, kind: b.kind, tag: b.tag, box: b.box };
    const fam = b.family ?? id;
    // part of a stroke whose other pieces are still here: the stroke was edited, not deleted
    if (present.has(fam)) editOnce(fam, gone); else delOnce(fam, gone);
  }
  pruneTombstones(d.tombstones);
  return { diff, baseline: baselineOf(d) };
}

export const diffIsEmpty = (diff) => !diff || !(diff.add.length || diff.del.length || diff.move.length || diff.edit.length);

function pruneTombstones(t) {
  const ids = Object.keys(t);
  if (ids.length <= TOMBSTONE_MAX) return;
  ids.sort((a, b) => ms(t[a].at) - ms(t[b].at));
  for (const id of ids.slice(0, ids.length - TOMBSTONE_MAX)) delete t[id];
}

// ---------- history ----------

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; if (o[k] <= 0) delete o[k]; };
const uidish = () => (globalThis.crypto?.randomUUID?.() || `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const historySort = (a, b) => ms(a.at) - ms(b.at) || String(a.id).localeCompare(String(b.id));

/**
 * Add one save's diff to a drawing's history. A person's saves within FOLD_MS of their last
 * entry fold into it, so placing 4 receptacles over two minutes is one line. Something added
 * and deleted again inside one entry cancels out. Returns the new history (sorted, capped).
 */
export function recordChange(history, diff, who, now = new Date().toISOString(), { foldMs = FOLD_MS, newId = uidish } = {}) {
  const list = Array.isArray(history) ? history.map((e) => ({ ...e })) : [];
  if (diffIsEmpty(diff)) return list;
  const by = person(who);
  let e = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (x.by?.id === by.id && x.by?.name === by.name && ms(now) - ms(x.until || x.at) <= foldMs && ms(now) >= ms(x.at)) { e = x; break; }
  }
  if (e) {
    e.add = { ...e.add }; e.del = { ...e.del }; e.move = { ...e.move }; e.edit = { ...e.edit };
    e.ids = [...(e.ids || [])]; e.ch = [...(e.ch || [])];
  } else {
    e = { id: newId(), by, at: now, until: now, add: {}, del: {}, move: {}, edit: {}, box: null, ids: [], ch: [] };
    list.push(e);
  }
  const added = new Set(e.ids), changed = new Set(e.ch);
  for (const x of diff.add) { bump(e.add, x.tag); added.add(x.id); e.box = growBox(e.box, x.box); }
  for (const x of diff.del) {
    if (added.has(x.id)) { bump(e.add, x.tag, -1); added.delete(x.id); } else bump(e.del, x.tag);
    e.box = growBox(e.box, x.box);
  }
  for (const k of ['move', 'edit']) {
    for (const x of diff[k]) {
      e.box = growBox(e.box, x.box);
      if (added.has(x.id) || changed.has(`${k}:${x.id}`)) continue; // part of "added", or already counted
      bump(e[k], x.tag);
      changed.add(`${k}:${x.id}`);
    }
  }
  e.ids = [...added].slice(-ENTRY_IDS_MAX);
  e.ch = [...changed].slice(-ENTRY_IDS_MAX);
  e.until = now;
  if (e.box) e.box = e.box.map((n) => Math.round(n * 10) / 10);
  // an entry that cancelled out completely says nothing
  const out = list.filter((x) => x !== e || entryCount(x) > 0);
  out.sort(historySort);
  return out.slice(-HISTORY_MAX);
}

export const entryCount = (e) => ['add', 'del', 'move', 'edit'].reduce((s, k) => s + Object.values(e?.[k] || {}).reduce((a, n) => a + n, 0), 0);

// ---------- plain words ----------

const NAMES = {
  receptacle: ['duplex receptacle', 'duplex receptacles'],
  'receptacle-gfci': ['GFCI', 'GFCIs'],
  'receptacle-240': ['240V receptacle', '240V receptacles'],
  switch: ['switch', 'switches'],
  'switch-3way': ['3-way switch', '3-way switches'],
  'switch-dimmer': ['dimmer', 'dimmers'],
  smoke: ['smoke / CO alarm', 'smoke / CO alarms'],
  panel: ['panelboard', 'panelboards'],
  junction: ['junction box', 'junction boxes'],
  '@wire': ['wire run', 'wire runs'],
  '@mark': ['pen mark', 'pen marks'],
  '@measure': ['measurement', 'measurements'],
  '@text': ['label', 'labels'],
  '@room': ['room', 'rooms'],
  '@object': ['symbol', 'symbols'],
};

/** "4 duplex receptacles", "1 junction box". */
export function countWords(tag, n) {
  const pair = NAMES[tag] || (() => {
    const label = SYMBOLS[tag]?.label ? SYMBOLS[tag].label.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()) : tag;
    return [label, /(s|x|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`];
  })();
  return `${n} ${n === 1 ? pair[0] : pair[1]}`;
}

/** "a, b and c" */
export function joinWords(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const VERBS = [['add', 'added'], ['del', 'deleted'], ['move', 'moved'], ['edit', 'changed']];
/** Symbols first (most counted first), then wires, marks, labels, rooms. */
const tagOrder = ([a, n], [b, m]) => (a.startsWith('@') - b.startsWith('@')) || m - n || a.localeCompare(b);

/** "added 4 duplex receptacles and 1 GFCI, deleted 1 junction box" */
export function describeEntry(e) {
  const parts = [];
  for (const [k, verb] of VERBS) {
    const tags = Object.entries(e?.[k] || {}).filter(([, n]) => n > 0).sort(tagOrder);
    if (tags.length) parts.push(`${verb} ${joinWords(tags.map(([t, n]) => countWords(t, n)))}`);
  }
  return parts.join(', ') || 'made changes';
}

/** First name for history lines ("Jackson"), full name elsewhere. */
export const firstName = (name) => String(name || 'Someone').trim().split(/\s+/)[0] || 'Someone';

/**
 * History lines grouped by day, then by person: [{ day, label, people: [{ by, entries }] }],
 * newest day first, newest entries first. `entries` items are { entry, sheet, drawingId }.
 * @param {{ entry: object, sheet?: string|null, drawingId?: string }[]} rows
 * @param {{ now?: Date, dayKey?: (iso: string) => string }} [opts]
 */
export function groupHistory(rows, { now = new Date(), dayKey = localDayKey } = {}) {
  const sorted = [...rows].sort((a, b) => ms(b.entry.until || b.entry.at) - ms(a.entry.until || a.entry.at));
  const days = new Map();
  const today = dayKey(now.toISOString());
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y.toISOString());
  for (const r of sorted) {
    const k = dayKey(r.entry.until || r.entry.at);
    if (!days.has(k)) days.set(k, { day: k, label: k === today ? 'Today' : k === yesterday ? 'Yesterday' : k, people: new Map() });
    const d = days.get(k);
    const pk = `${r.entry.by?.id ?? ''}|${r.entry.by?.name ?? ''}`;
    if (!d.people.has(pk)) d.people.set(pk, { by: r.entry.by, entries: [] });
    d.people.get(pk).entries.push(r);
  }
  return [...days.values()].map((d) => ({ ...d, people: [...d.people.values()] }));
}

/** YYYY-MM-DD in local time. */
export function localDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- who drew what ----------

/** The author an item counts under for "who drew what": the last person to touch it. */
export function authorOf(it) {
  const p = it?.editBy || it?.by;
  return p ? person(p) : null;
}

/**
 * Everyone who touched a drawing, with item counts: [{ id, name, count, last }], most items
 * first; untracked items under { id: UNTRACKED_ID, name: BEFORE_TRACKING }.
 */
export function authors(d) {
  const m = new Map();
  for (const kind of ITEM_KINDS) {
    for (const it of d?.[kind] || []) {
      const a = authorOf(it);
      const key = a ? `${a.id ?? ''}|${a.name}` : UNTRACKED_ID;
      if (!m.has(key)) m.set(key, { key, id: a ? a.id : UNTRACKED_ID, name: a ? a.name : BEFORE_TRACKING, count: 0, last: '' });
      const x = m.get(key);
      x.count++;
      if (itemTime(it) > x.last) x.last = itemTime(it);
    }
  }
  return [...m.values()].sort((a, b) => (a.id === UNTRACKED_ID) - (b.id === UNTRACKED_ID) || b.count - a.count || a.name.localeCompare(b.name));
}

/** Since when a date filter reaches: 'all' | 'today' | 'yesterday' | '7d' | '30d'. Returns [fromMs, toMs]. */
export function dateRange(kind, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  switch (kind) {
    case 'today': return [start.getTime(), Infinity];
    case 'yesterday': return [start.getTime() - day, start.getTime()];
    case '7d': return [start.getTime() - 6 * day, Infinity];
    case '30d': return [start.getTime() - 29 * day, Infinity];
    default: return [-Infinity, Infinity];
  }
}

/**
 * Does an item pass the "who drew what" filter?
 * @param {object} it
 * @param {{ who?: string|null, when?: string }} f  who: an authors() key, or null for anyone
 */
export function itemMatches(it, f = {}, now = new Date()) {
  const a = authorOf(it);
  if (f.who) {
    const key = a ? `${a.id ?? ''}|${a.name}` : UNTRACKED_ID;
    if (key !== f.who) return false;
  }
  if (f.when && f.when !== 'all') {
    const t = ms(itemTime(it));
    if (!t) return false; // untracked items have no date
    const [from, to] = dateRange(f.when, now);
    if (t < from || t >= to) return false;
  }
  return true;
}

/** "Jackson · Oct 19, 2:14 pm" style facts for a selected item. */
export function attributionLines(it) {
  if (!it?.by && !it?.editBy) return [{ label: BEFORE_TRACKING, who: null, at: null }];
  const out = [];
  if (it.by) out.push({ label: 'Added by', who: person(it.by), at: it.at || null });
  if (it.editBy) out.push({ label: 'Last edit', who: person(it.editBy), at: it.editAt || null });
  return out;
}

// ---------- merge ----------

const byId = (list) => new Map((list || []).filter((x) => x?.id).map((x) => [x.id, x]));

/**
 * Merge two copies of a drawing object by object, so two people editing different parts of a
 * drawing (on two devices, offline or not) both keep their work. `incoming` is the write
 * being applied, `current` the stored copy.
 * - Items: union by id; when both have an item, the later edit (editAt/at) wins, ties go to
 *   `incoming`. A tombstone deletes an item unless the item was edited after it.
 * - Tombstones and history: union (history by entry id, the longer-running copy of an entry wins).
 * - Layers: `incoming`'s, plus any layer a surviving item still sits on.
 * - Everything else (name, scale, underlay, view...): `incoming`'s; updatedAt is the later one.
 * - A piece the area eraser cut (cutFrom/splitFrom) that one copy never saw (no piece, no
 *   tombstone) goes when that copy deleted or changed the stroke it was cut from after the cut,
 *   and that change wins: the whole-stroke delete or redraw beats a cut it did not know about.
 * Idempotent: merging a copy that already holds everything returns an equal copy.
 * A write without `tombstones` comes from an app from before tracking, which deletes by
 * leaving items out: it replaces the stored copy. The server never merges such a write, nor
 * one from an older app that carried the stored tombstones over (access.js mergeWrite): both
 * are last-writer-wins there, so a stale copy loses to the newer stored one.
 */
export function mergeDrawing(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (!incoming.tombstones || typeof incoming.tombstones !== 'object') return incoming;
  const out = { ...incoming };
  const tomb = { ...(current.tombstones || {}) };
  for (const [id, t] of Object.entries(incoming.tombstones || {})) {
    if (!tomb[id] || ms(t?.at) >= ms(tomb[id]?.at)) tomb[id] = t;
  }
  const dead = (it) => tomb[it.id] && ms(tomb[it.id].at) >= ms(itemTime(it));
  const curTomb = current.tombstones || {}, incTomb = incoming.tombstones || {};
  for (const kind of ITEM_KINDS) {
    const a = current[kind] || [];
    const b = incoming[kind] || [];
    if (!a.length && !Array.isArray(incoming[kind])) continue;
    const mine = byId(a), theirs = byId(b);
    // A piece cut from stroke `src` on one device, while a copy that never saw the cut deleted
    // or changed `src` later (and that change wins): the piece belongs to a stroke that is gone
    // or was redrawn whole, so it goes too (else a deleted line comes back in part, or the
    // erased gap reappears with the rest drawn twice).
    const cutUnseen = (it) => {
      const t = ms(itemTime(it));
      for (const [items, tb, other, otherTb] of [[mine, curTomb, theirs, incTomb], [theirs, incTomb, mine, curTomb]]) {
        if (items.has(it.id) || tb[it.id]) continue; // this copy knew the piece
        // the stroke the piece was cut from; for a piece of a piece this copy never saw, the original
        const known = (id) => id && id !== it.id && (items.has(id) || tb[id]);
        const src = known(it.cutFrom) ? it.cutFrom : known(it.splitFrom) ? it.splitFrom : null;
        if (!src) continue;
        // its edit of src came after the cut, or it deleted src at or after it (as dead() counts)
        const s = items.get(src);
        const changed = s ? ms(itemTime(s)) : ms(tb[src].at);
        if (s ? changed <= t : changed < t) continue;
        // ...and that change wins over the other copy's: its later edit of src, or its later delete
        const o = other.get(src), ot = otherTb[src];
        if (o && changed < ms(itemTime(o))) continue;
        if (ot && (s ? changed <= ms(ot.at) : changed < ms(ot.at))) continue;
        return true;
      }
      return false;
    };
    const merged = [];
    const used = new Set();
    for (const it of b) {
      if (!it?.id) { merged.push(it); continue; }
      used.add(it.id);
      const other = mine.get(it.id);
      const pick = other && ms(itemTime(other)) > ms(itemTime(it)) ? other : it;
      if (!dead(pick)) merged.push(pick);
    }
    for (const it of a) {
      if (!it?.id || used.has(it.id)) continue;
      if (!dead(it)) merged.push(it);
    }
    out[kind] = merged.filter((it) => !it?.id || !cutUnseen(it));
  }
  // a tombstone whose item came back with a later edit no longer applies
  for (const kind of ITEM_KINDS) for (const it of out[kind] || []) if (it?.id && tomb[it.id]) delete tomb[it.id];
  if (Object.keys(tomb).length || incoming.tombstones || current.tombstones) {
    pruneTombstones(tomb);
    out.tombstones = tomb;
  }
  if (Array.isArray(current.history) || Array.isArray(incoming.history)) {
    const h = byId(current.history);
    for (const e of incoming.history || []) {
      const o = h.get(e.id);
      if (!o || ms(e.until || e.at) >= ms(o.until || o.at)) h.set(e.id, e);
    }
    out.history = [...h.values()].sort(historySort).slice(-HISTORY_MAX);
  }
  // layers: keep any layer a surviving item still uses
  if (Array.isArray(incoming.layers) && Array.isArray(current.layers)) {
    const have = new Set(incoming.layers.map((l) => l.id));
    const used = new Set(ITEM_KINDS.flatMap((k) => (out[k] || []).map((it) => it?.layer)));
    const extra = current.layers.filter((l) => !have.has(l.id) && used.has(l.id));
    if (extra.length) out.layers = [...incoming.layers, ...extra];
  }
  for (const k of ['editedAt', 'updatedAt']) {
    if (ms(current[k]) > ms(incoming[k])) out[k] = current[k];
  }
  if (ms(current.editedAt) > ms(incoming.editedAt)) out.editedBy = current.editedBy;
  return out;
}

/** True when merging `other` into `d` would change d's items (another device added or changed something). */
export function itemsDiffer(a, b) {
  for (const kind of ITEM_KINDS) {
    const x = a?.[kind] || [], y = b?.[kind] || [];
    if (x.length !== y.length) return true;
    const m = byId(y);
    for (const it of x) { const o = m.get(it.id); if (!o || canon(o) !== canon(it)) return true; }
  }
  return false;
}
