// The canvas editor's collaboration layer: stamping who drew what on save, the Changes panel
// (history grouped by person and day, "who drew what" with a person and date filter, and the
// cost impact for money roles), the author tint over the plan, and merging another device's
// copy into an open drawing. Pure logic lives in lib/drawing-collab.js and lib/drawing-costs.js;
// this file only touches the editor through the small API it is given, never pointer input.
import { drawStroke, drawObject, drawText } from './engine.js';
import {
  baselineOf, stampChanges, recordChange, diffIsEmpty, describeEntry, groupHistory, firstName, authors, itemMatches,
  attributionLines, authorOf, mergeDrawing, itemsDiffer, canon, person, ITEM_KINDS, UNTRACKED_ID, BEFORE_TRACKING,
} from '../lib/drawing-collab.js';
import { jobCostImpact, changeOrderFrom } from '../lib/drawing-costs.js';
import { sheetLabel } from '../lib/plansets.js';

const CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
const PEOPLE = '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3 3 0 010 6M21 20c0-2.6-1.7-4.8-4-5.6"/>';
export const COLLAB_ICON = CLOCK;
const PALETTE = ['#1f5fb8', '#c25e00', '#7a3fb0', '#1d7044', '#b42318', '#0f7b8a', '#8a5a00', '#d6457a'];
const GREY = '#8a8478';
/** Fields another device may change while this one has the drawing open (taken when this one did not change them). */
const SCALARS = ['name', 'jobId', 'clientId', 'planSet', 'scale', 'scaleSet', 'paper'];
const DATES = [{ id: 'all', label: 'Any time' }, { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }];
const SHEET_FIELDS = ['underlay', 'strokes', 'texts', 'rooms', 'codeOptions', 'placement', 'view', 'thumb', 'tombstones'];

function hashColor(key) {
  let n = 0;
  for (const ch of String(key)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

/**
 * @param {object} api  { d, id, st, store, ui, auth, nav, wrap, z, centerOn, requestFrame, isDark, layerOf, getView, onSaveNeeded, setSheets }
 */
export function createCollab(api) {
  const { d, id, store, ui, auth, nav } = api;
  const { h, icon } = ui;
  d.tombstones ||= {};
  d.history ||= [];
  let baseline = baselineOf(d);
  let scalarBase = pickScalars(d);
  const money = auth.seesMoney?.() ?? false;
  const view = { show: false, who: null, when: 'all' };
  let tab = 'history';
  let scope = 'set';
  let open = false;
  let flash = null; // { box, until }
  let costTimer = 0;
  let lastImpact = null;

  // ---------- stamping on save ----------
  /** Called by the editor's save() before the record goes to the store. */
  function beforeSave(patch, contentChanged) {
    patch.tombstones = d.tombstones;
    patch.history = d.history;
    if (!contentChanged) return;
    const who = auth.who();
    const now = new Date().toISOString();
    const r = stampChanges(d, baseline, who, now);
    baseline = r.baseline;
    patch.tombstones = d.tombstones;
    if (diffIsEmpty(r.diff)) return;
    d.history = recordChange(d.history, r.diff, who, now);
    d.editedBy = person(who);
    d.editedAt = now;
    Object.assign(patch, { strokes: d.strokes, objects: d.objects, texts: d.texts, rooms: d.rooms, history: d.history, editedBy: d.editedBy, editedAt: d.editedAt });
    if (open) scheduleRender();
  }

  function pickScalars(x) { return Object.fromEntries(SCALARS.map((k) => [k, canon(x[k] ?? null)])); }

  /**
   * Another device's copy arrived (sync pull or a merged push result). Local edits were saved
   * (stamped) first by the editor. Merge per object into the open drawing.
   * @returns {{ changed: boolean, dirty: boolean }} changed: the items on screen changed;
   *   dirty: this device holds something the arriving copy does not (save again).
   */
  function mergeRemote(remote) {
    if (!remote) return { changed: false, dirty: false };
    const local = { tombstones: d.tombstones, history: d.history, layers: d.layers, updatedAt: d.updatedAt };
    for (const k of ITEM_KINDS) local[k] = d[k];
    const merged = mergeDrawing(remote, local);
    const changed = itemsDiffer(merged, local);
    const dirty = itemsDiffer(merged, remote) || canon(merged.tombstones || {}) !== canon(remote.tombstones || {})
      || canon((merged.history || []).map((e) => [e.id, e.until])) !== canon((remote.history || []).map((e) => [e.id, e.until]));
    for (const k of ITEM_KINDS) d[k] = merged[k] || [];
    d.tombstones = merged.tombstones || {};
    d.history = merged.history || [];
    if (merged.layers) d.layers = merged.layers;
    if (remote.editedAt && (!d.editedAt || remote.editedAt > d.editedAt)) { d.editedAt = remote.editedAt; d.editedBy = remote.editedBy; }
    // fields this device did not touch follow the other device (a renamed set, a new scale)
    const now = pickScalars(d);
    let scal = false;
    for (const k of SCALARS) {
      if (now[k] === scalarBase[k] && canon(remote[k] ?? null) !== now[k] && k in remote) { d[k] = remote[k]; scal = true; }
    }
    scalarBase = pickScalars(d);
    baseline = baselineOf(d);
    if (open) scheduleRender();
    return { changed: changed || scal, dirty };
  }

  // ---------- overlay: who drew what ----------
  const colorCache = new Map();
  function colorFor(a) {
    if (!a) return GREY;
    const key = `${a.id ?? ''}|${a.name}`;
    if (!colorCache.has(key)) colorCache.set(key, (a.id && store.get('employees', a.id)?.color) || hashColor(key));
    return colorCache.get(key);
  }

  function overlay(g) {
    const zz = api.z();
    if (flash && Date.now() < flash.until) {
      const [x0, y0, x1, y1] = flash.box;
      const pad = 10 / zz;
      g.save();
      g.strokeStyle = '#f5b301'; g.lineWidth = 3 / zz; g.setLineDash([]);
      g.strokeRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2);
      g.restore();
      api.requestFrame();
    } else flash = null;
    if (!view.show) return;
    const dark = api.isDark();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 0.62;
    g.fillStyle = dark ? '#1d1f22' : '#f7f6f2';
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    g.restore();
    const vis = (it) => api.layerOf(it.layer)?.visible !== false;
    const ok = (it) => vis(it) && itemMatches(it, view);
    const badges = [];
    g.save();
    for (const r of d.rooms) {
      if (!ok(r) || !r.points?.length) continue;
      g.strokeStyle = colorFor(authorOf(r)); g.lineWidth = 3 / zz;
      g.beginPath(); r.points.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
      badges.push([r.points[0][0], r.points[0][1], authorOf(r)]);
    }
    for (const s of d.strokes) {
      if (!ok(s) || !s.points?.length) continue;
      drawStroke(g, { ...s, color: colorFor(authorOf(s)), opacity: 1 }, d, { zoom: zz, dark: false });
      if (s.tool === 'wire' || s.tool === 'measure') badges.push([s.points[0][0], s.points[0][1], authorOf(s)]);
    }
    for (const o of d.objects) {
      if (!ok(o)) continue;
      drawObject(g, { ...o, color: colorFor(authorOf(o)) }, { dark: false });
      badges.push([o.x + 14 * (o.scale || 1), o.y + 14 * (o.scale || 1), authorOf(o)]);
    }
    for (const t of d.texts) {
      if (!ok(t)) continue;
      drawText(g, { ...t, color: colorFor(authorOf(t)) }, { dark: false });
      badges.push([t.x - 4, t.y - 4, authorOf(t)]);
    }
    // initials badges (screen-sized), capped so a busy sheet stays readable
    if (zz > 0.35) {
      const r = 8 / zz;
      g.font = `700 ${9 / zz}px Inter, system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const [x, y, a] of badges.slice(0, 500)) {
        g.fillStyle = colorFor(a);
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.fillText(a ? ui.initials(a.name) : '?', x, y + 0.5 / zz);
      }
    }
    g.restore();
  }

  // ---------- the panel ----------
  const tabsHost = h('div', { class: 'cv-changes-tabs' });
  const body = h('div', { class: 'cv-findings-list cv-changes-body' });
  const foot = h('footer', { class: 'cv-findings-foot cv-changes-foot', hidden: true });
  const panel = h('aside', { class: 'cv-findings cv-changes', hidden: true, 'aria-label': 'Changes and who drew what' },
    h('header', { class: 'cv-findings-head' },
      h('div', { class: 'grow' }, h('strong', null, 'Changes'), h('div', { class: 'cv-findings-book' }, money ? 'Who drew what, and what it does to the price' : 'Who drew what, and when')),
      h('button', { class: 'cv-btn', type: 'button', title: 'Close', 'aria-label': 'Close changes', onClick: () => close() }, icon('x', 18))),
    tabsHost, body, foot);
  api.wrap.append(panel);

  // a chip on the plan while authors are shown, so the mode is never a mystery
  const chip = h('div', { class: 'cv-attr-chip', hidden: true, role: 'status' });
  api.wrap.append(chip);

  function renderChip() {
    chip.hidden = !view.show;
    if (!view.show) return;
    const who = view.who ? (authors(d).find((a) => a.key === view.who || a.id === view.who)?.name || 'One person') : 'Everyone';
    ui.clear(chip).append(icon(PEOPLE, 16), h('span', null, `${who} · ${DATES.find((x) => x.id === view.when)?.label || 'Any time'}`),
      h('button', { type: 'button', class: 'cv-attr-chip-x', title: 'Stop showing who drew what', 'aria-label': 'Stop showing who drew what', onClick: () => setShow(false) }, icon('x', 14)));
  }

  function setShow(on) {
    view.show = on;
    renderChip();
    if (open && tab === 'who') renderBody();
    api.requestFrame();
  }

  let renderTimer = 0;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderBody, 250); }

  function openPanel(which) {
    if (which) tab = which;
    if (tab === 'cost' && !money) tab = 'history';
    open = true;
    panel.hidden = false;
    api.onPanel?.(true);
    renderTabs();
    renderBody();
  }
  function close() { open = false; panel.hidden = true; api.onPanel?.(false); }

  function renderTabs() {
    const items = [{ id: 'history', label: 'History' }, { id: 'who', label: 'Who drew what' }];
    if (money) items.push({ id: 'cost', label: 'Cost impact' });
    ui.clear(tabsHost).append(ui.tabs(items, tab, (t) => { tab = t; renderTabs(); renderBody(); }));
  }

  function renderBody() {
    if (!open) return;
    ui.clear(body);
    foot.hidden = true;
    ui.clear(foot);
    if (tab === 'who') renderWho();
    else if (tab === 'cost' && money) renderCost();
    else renderHistory();
  }

  const when = (iso) => {
    if (!iso) return '';
    const t = new Date(iso);
    const today = new Date();
    const sameDay = t.toDateString() === today.toDateString();
    return sameDay ? `today ${ui.fmtTime(iso)}` : `${ui.fmtDate(iso, { month: 'short', day: 'numeric' })} ${ui.fmtTime(iso)}`;
  };

  // ----- history -----
  function historyRows() {
    const here = { entry: null, sheet: d.planSet ? sheetLabel(d.planSet) : null, drawingId: id };
    const rows = (d.history || []).map((entry) => ({ ...here, entry }));
    if (scope !== 'set' || !d.planSet?.id) return rows;
    const others = store.list('drawings', (x) => x.planSet?.id === d.planSet.id && x.id !== id, { omit: SHEET_FIELDS });
    for (const x of others) for (const entry of x.history || []) rows.push({ entry, sheet: sheetLabel(x.planSet), drawingId: x.id });
    return rows;
  }

  function renderHistory() {
    if (d.planSet?.id) {
      body.append(h('div', { class: 'cv-changes-scope' }, ui.tabs([{ id: 'set', label: 'Whole set' }, { id: 'sheet', label: 'This sheet' }], scope, (s) => { scope = s; renderBody(); })));
    }
    const groups = groupHistory(historyRows());
    if (!groups.length) {
      body.append(h('div', { class: 'cv-changes-empty' },
        h('p', null, 'No changes recorded yet.'),
        h('p', { class: 'muted' }, 'From now on, every symbol, wire, label and room added, moved or deleted shows here with who did it. Items drawn before tracking show as "Before tracking".')));
      return;
    }
    for (const g of groups) {
      body.append(h('h3', { class: 'cv-changes-day' }, g.label === g.day ? ui.fmtDate(g.day, { weekday: 'short', month: 'short', day: 'numeric' }) : g.label));
      for (const p of g.people) {
        const name = p.by?.name || 'Someone';
        const block = h('div', { class: 'cv-changes-person' },
          h('div', { class: 'cv-changes-who' }, h('span', { class: 'avatar', style: { background: colorFor(p.by) } }, ui.initials(name)), h('strong', null, name)));
        for (const r of p.entries) {
          const e = r.entry;
          const text = `${firstName(name)} ${describeEntry(e)}${r.sheet ? ` on sheet ${r.sheet}` : ''}`;
          const other = r.drawingId !== id;
          block.append(h('button', { class: 'cv-change', type: 'button', dataset: { entry: e.id }, title: e.box ? (other ? 'Open that sheet and zoom to it' : 'Zoom to it') : '',
            onClick: () => goTo(r) },
          h('span', { class: 'cv-change-text' }, text),
          h('span', { class: 'cv-change-meta' }, when(e.until || e.at), other ? ' · other sheet' : '')));
        }
        body.append(block);
      }
    }
  }

  function goTo(r) {
    if (r.drawingId !== id) { api.flushSave(); nav(`#/drawings/${r.drawingId}?focus=${encodeURIComponent(r.entry.id)}`); return; }
    focusEntry(r.entry.id);
  }

  /** Zoom to a history entry on this drawing (also used for ?focus= links). */
  function focusEntry(entryId) {
    const e = (d.history || []).find((x) => x.id === entryId);
    if (!e?.box) return false;
    const [x0, y0, x1, y1] = e.box;
    const w = Math.max(60, x1 - x0), hh = Math.max(60, y1 - y0);
    const vw = api.size().w, vh = api.size().h;
    const zoom = Math.max(0.2, Math.min(3, Math.min((vw * 0.5) / w, (vh * 0.5) / hh)));
    api.centerOn((x0 + x1) / 2, (y0 + y1) / 2, zoom);
    flash = { box: e.box, until: Date.now() + 2400 };
    for (const b of body.querySelectorAll('.cv-change.on')) b.classList.remove('on');
    body.querySelector(`.cv-change[data-entry="${CSS.escape(entryId)}"]`)?.classList.add('on');
    api.requestFrame();
    return true;
  }

  // ----- who drew what -----
  function renderWho() {
    const list = authors(d);
    const toggle = h('label', { class: 'cv-changes-toggle' },
      h('input', { type: 'checkbox', checked: view.show, onChange: (e) => setShow(e.target.checked) }),
      h('span', null, 'Show who drew what on the plan'));
    const whoSel = h('select', { class: 'input', 'aria-label': 'Person', onChange: (e) => { view.who = e.target.value || null; if (!view.show) setShow(true); else { renderChip(); api.requestFrame(); } } },
      h('option', { value: '' }, 'Everyone'), list.map((a) => h('option', { value: a.key, selected: view.who === a.key }, a.name)));
    const whenSel = h('select', { class: 'input', 'aria-label': 'Date', onChange: (e) => { view.when = e.target.value; if (!view.show) setShow(true); else { renderChip(); api.requestFrame(); } } },
      DATES.map((x) => h('option', { value: x.id, selected: view.when === x.id }, x.label)));
    body.append(h('div', { class: 'cv-changes-filters' }, toggle, h('div', { class: 'cv-changes-selects' }, whoSel, whenSel)));
    if (!list.length) { body.append(h('p', { class: 'muted cv-changes-empty' }, 'Nothing drawn yet.')); return; }
    const total = list.reduce((s, a) => s + a.count, 0);
    for (const a of list) {
      const on = view.who === a.key;
      body.append(h('button', { class: ['cv-author', on ? 'on' : null], type: 'button', 'aria-pressed': String(on),
        onClick: () => { view.who = on ? null : a.key; setShow(true); renderBody(); } },
      h('span', { class: 'cv-author-dot', style: { background: a.id === UNTRACKED_ID ? GREY : colorFor(a) } }),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, a.name),
        h('span', { class: 'meta' }, a.id === UNTRACKED_ID ? 'Drawn before tracking started' : `Last ${when(a.last)}`)),
      h('span', { class: 'cv-author-n' }, `${a.count}`), h('span', { class: 'muted cv-author-pct' }, `${Math.round((a.count / total) * 100)}%`)));
    }
  }

  // ----- cost impact (money roles only) -----
  function impact() {
    const job = d.jobId ? store.get('jobs', d.jobId) : null;
    if (!job) return { ready: false, reason: 'no-job' };
    const drawings = store.list('drawings', (x) => x.jobId === job.id && x.id !== id, { omit: ['underlay', 'strokes', 'texts', 'rooms', 'thumb', 'view', 'tombstones'] });
    drawings.push({ id, name: d.name, objects: d.objects, history: d.history });
    return jobCostImpact({ job, drawings, estimates: store.list('estimates', (e) => e.jobId === job.id || e.id === job.estimateId), items: store.list('items', (i) => i.symbol), settings: store.settings() });
  }

  function renderCost() {
    const r = impact();
    lastImpact = r;
    const fmt = (c) => ui.fmtMoney(c);
    const signed = (c) => `${c < 0 ? '−' : '+'}${fmt(Math.abs(c))}`;
    if (!r.ready) {
      const msg = r.reason === 'no-job'
        ? 'Link this drawing to a job (More → Details) to compare it with the job\'s estimate.'
        : `${r.job.number || 'This job'} has no estimate yet, so there is nothing to compare with.`;
      body.append(h('div', { class: 'cv-changes-empty' }, h('p', null, msg),
        r.reason === 'no-estimate' && auth.can('estimates') ? ui.button('Create estimate from takeoff', { size: 'sm', icon: 'file-text', onClick: () => { api.flushSave(); nav(`#/estimates/new?fromDrawing=${encodeURIComponent(id)}`); } }) : null));
      return;
    }
    const n = r.drawings.length;
    body.append(h('p', { class: 'cv-cost-head' }, `Compared with ${r.estimate.number || 'the estimate'}${r.estimate.status ? ` (${r.estimate.status})` : ''} · ${n} drawing${n === 1 ? '' : 's'} on ${r.job.number || 'this job'}`));
    if (!r.lines.length) {
      body.append(h('div', { class: 'cv-changes-empty' }, h('p', null, 'The drawings match the estimate and the change orders already raised.')));
      return;
    }
    for (const l of r.lines) {
      const who = (r.who[l.symbol] || []).map((g) => `${l.diff > 0 ? 'added' : 'removed'} by ${g.who ? firstName(g.who.name) : 'someone before tracking'}${g.to ? ` ${when(g.to)}` : ''}${(r.who[l.symbol] || []).length > 1 ? ` (${g.n})` : ''}`).join(', ');
      body.append(h('div', { class: ['cv-cost-line', l.diff > 0 ? 'up' : 'down'], dataset: { symbol: l.symbol } },
        h('div', { class: 'cv-cost-main' }, h('strong', null, `${l.diff > 0 ? '+' : '−'}${l.label}`),
          h('span', { class: 'num' }, l.itemId ? signed(l.materialCents) : 'not priced')),
        h('div', { class: 'cv-cost-meta' },
          l.itemId ? `${l.labourHours > 0 ? '+' : '−'}${Math.abs(l.labourHours)} labour h` : 'No price-book item for this symbol',
          who ? ` · ${who}` : '')));
    }
    const t = r.totals;
    const row = (label, value, cls) => h('div', { class: ['cv-cost-total', cls] }, h('span', null, label), h('span', { class: 'num' }, value));
    body.append(h('div', { class: 'cv-cost-totals' },
      row('Material', signed(t.materialCents)),
      t.markupCents ? row(`Markup ${t.markupPct}%`, signed(t.markupCents)) : null,
      row(`Labour ${t.labourHours > 0 ? '+' : t.labourHours < 0 ? '−' : ''}${Math.abs(t.labourHours)} h`, t.labourSeparate ? signed(t.labourCents) : `${signed(t.labourCents)} (in the price)`),
      row('Change', signed(t.totalCents), 'grand')));
    if (r.unpriced.length) body.append(h('p', { class: 'muted cv-cost-note' }, `${r.unpriced.length} symbol type${r.unpriced.length === 1 ? ' has' : 's have'} no price-book item; add one in Inventory to price it.`));
    if (!t.labourSeparate) body.append(h('p', { class: 'muted cv-cost-note' }, `Labour at ${fmt(t.labourRateCents)}/h is shown for planning: the estimate's price-book prices include it.`));
    foot.hidden = false;
    const canCo = auth.isManager() && auth.can('jobs');
    foot.append(ui.button('Create change order', { variant: 'primary', icon: 'plus', disabled: !canCo, title: canCo ? 'Add these lines to the job as a pending change order' : 'Managers raise change orders', onClick: () => createChangeOrder() }));
  }

  function createChangeOrder() {
    api.flushSave();
    const r = impact();
    if (!r.ready || !r.lines.length) { ui.toast('Nothing to add: the drawings match the estimate', 'info'); renderBody(); return null; }
    const job = store.get('jobs', r.job.id);
    const co = changeOrderFrom(r, {
      id: 'co-' + Date.now().toString(36), date: ui.today(), createdBy: auth.who(), createdAt: new Date().toISOString(),
      drawingIds: r.drawings.map((x) => x.id), estimate: r.estimate, who: r.who, when,
    });
    store.update('jobs', job.id, { changeOrders: [...(job.changeOrders || []), co] }, { summary: `${job.number}: change order from drawings` });
    ui.toast(`Change order added to ${job.number}: ${ui.fmtMoney(co.amountCents)} pending`, 'success', 4000);
    renderBody();
    foot.hidden = false;
    ui.clear(foot).append(h('span', { class: 'grow muted' }, `${co.title}`), ui.button('Open job', { size: 'sm', icon: 'briefcase', onClick: () => { api.flushSave(); nav(`#/jobs/${job.id}?tab=changes`); } }));
    return co;
  }

  // ---------- selection label ----------
  /** "Added by Jackson · today 2:14 pm" for the context bar when one item is selected. */
  function selectionInfo(item) {
    if (!item) return null;
    const lines = attributionLines(item);
    const text = lines.map((l) => (l.who ? `${l.label} ${firstName(l.who.name)}${l.at ? ` · ${when(l.at)}` : ''}` : l.label)).join(' · ');
    return h('span', { class: 'cv-ctx-label cv-attr', title: lines.map((l) => (l.who ? `${l.label} ${l.who.name}${l.at ? ` ${new Date(l.at).toLocaleString()}` : ''}` : l.label)).join('\n') },
      h('span', { class: 'cv-author-dot', style: { background: colorFor(authorOf(item)) } }), text);
  }

  /** The editor calls this after every content change. */
  function onChanged() {
    if (!open) return;
    clearTimeout(costTimer);
    costTimer = setTimeout(() => { if (tab !== 'history') renderBody(); }, 400);
  }

  function destroy() {
    clearTimeout(renderTimer); clearTimeout(costTimer);
    panel.remove(); chip.remove();
  }

  return {
    beforeSave, mergeRemote, overlay, open: openPanel, close, focusEntry, selectionInfo, onChanged, destroy, setShow,
    createChangeOrder, impact: () => lastImpact || impact(), get isOpen() { return open; }, get view() { return { ...view }; },
    BEFORE_TRACKING,
  };
}
