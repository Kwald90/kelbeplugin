// Rooms on the canvas: draw a room (rectangle or polygon), mark doors,
// windows, counters and fixtures, auto-place boxes as ghosts, and run the
// code check with markers and a findings panel. The editor owns pointers and
// chrome; it hands events here first and asks for overlay drawing and the
// context bar. All geometry and rules live in js/lib/placement*.js.
import { uid } from '../store.js';
import { getUnits, fmtLength, parseLength } from '../lib/units.js';
import {
  pxPerM, rectPoints, projectToWalls, featureSpan, featureCorners, pointInPoly, distToSeg, wallPoint, proposeRoom, proposeAll,
  buildModel,
} from '../lib/placement.js';
import { checkDrawing, summarize } from '../lib/placement-check.js';
import { RULES, ROOM_TYPES, ROOM_TYPE_ORDER, FEATURE_KINDS, FEATURE_ORDER, placementSettings, ruleLabel } from '../lib/placement-rules.js';
import { drawObject, roomGeo, roomSizeLabel, hitTest } from './engine.js';
import { SYMBOLS } from './symbols.js';

export const ROOM_ICON = '<path d="M4 4h16v16H4z"/><path d="M4 14h5M13 4v6"/><path d="M9 14a5 5 0 015-5"/>';
export const CHECK_ICON = '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>';
export const WAND_ICON = '<path d="M5 19L16 8"/><path d="M14 6l4 4"/><path d="M18 3v3M21 5h-3M8 3v2M9 4H7M20 13v2M21 14h-2"/>';

/**
 * A touch tap ends with a synthetic click on whatever is under the finger. When
 * a pointer handler opens a sheet, that click lands on the sheet's scrim and
 * closes it at once; swallow it.
 */
export function swallowNextClick(ms = 500) {
  const kill = (e) => { e.stopPropagation(); e.preventDefault(); done(); };
  const done = () => { document.removeEventListener('click', kill, true); clearTimeout(t); };
  document.addEventListener('click', kill, true);
  const t = setTimeout(done, ms);
}

const SEV_COLOR = { error: '#c62f2f', warning: '#e07a1f', info: '#1f5fb8' };
const SEV_LABEL = { error: 'Must fix', warning: 'Check', info: 'Note' };
const ACCENT = '#f5b301';

/**
 * api: { d, st, store, ui, auth, wrap, z, checkpoint, changed, requestFrame, updateChrome, setTool,
 *        centerOn(x, y, zoom), label(ctx, point, text), isDark, layerOf, usable }
 */
export function createRooms(api) {
  const { d, st, store, ui } = api;
  const { h, icon } = ui;
  let draft = null; // { mode: 'rect', a, b } | { mode: 'poly', pts, hover }
  let drag = null; // vertex | feature | featureDraw | ghost
  let ghosts = []; // proposals waiting for accept/discard
  let findings = [];
  let selFinding = null;
  let panelOpen = false;
  let featureKind = null;
  let snapMark = null;
  let liveTimer = 0;
  st.roomMode ||= 'rect';

  const z = () => api.z();
  const ppm = () => pxPerM(d.scale);
  const units = () => getUnits(store.settings().units);
  const fmt = (m, denom = 2) => fmtLength(m, { units: units(), denom });
  const settings = () => placementSettings(store.settings().placement, d.placement);
  const codeOptions = () => d.codeOptions || {};
  const selectedRoom = () => (st.selection.length === 1 && st.selection[0].kind === 'room' ? d.rooms.find((r) => r.id === st.selection[0].id) : null);
  const readLen = (v) => {
    let m = parseLength(v, { units: units() });
    // a metric user typing "810" means millimetres, not 810 m
    if (m != null && units() === 'metric' && /^\s*\d+(\.\d+)?\s*$/.test(String(v)) && m > 30) m /= 1000;
    return m;
  };

  // ---------- layers ----------
  function roomsLayer() {
    let l = d.layers.find((x) => x.kind === 'rooms');
    if (!l) {
      l = { id: 'L' + uid().slice(0, 8), name: 'Rooms', kind: 'rooms', visible: true, locked: false, opacity: 1 };
      d.layers.unshift(l); // bottom of the stack, under the symbols
    }
    return l;
  }
  function deviceLayer() {
    const ok = (l) => l && l.visible !== false && !l.locked && l.kind !== 'rooms';
    const active = api.layerOf(st.activeLayer);
    if (ok(active)) return active.id;
    const top = [...d.layers].reverse().find(ok);
    if (top) return top.id;
    const l = { id: 'L' + uid().slice(0, 8), name: 'Devices', visible: true, locked: false, opacity: 1 };
    d.layers.push(l);
    return l.id;
  }

  // ---------- snapping ----------
  function snap(wx, wy, { prev, exclude } = {}) {
    const tol = 14 / z();
    let best = null, bd = tol;
    for (const r of d.rooms) {
      r.points.forEach((p, i) => {
        if (exclude && exclude.room === r && exclude.idx === i) return;
        const dd = Math.hypot(p[0] - wx, p[1] - wy);
        if (dd < bd) { bd = dd; best = [p[0], p[1]]; }
      });
    }
    if (best) { snapMark = best; return best; }
    snapMark = null;
    // round to 50 mm (2" for imperial users) at the drawing scale
    const step = (units() === 'imperial' ? 2 * 0.0254 : 0.05) * ppm();
    let x = Math.round(wx / step) * step, y = Math.round(wy / step) * step;
    const align = 8 / z();
    if (prev) {
      const ang = Math.abs(Math.atan2(wy - prev[1], wx - prev[0]));
      if (ang < 0.14 || ang > Math.PI - 0.14) y = prev[1];
      else if (Math.abs(ang - Math.PI / 2) < 0.14) x = prev[0];
    }
    for (const r of d.rooms) for (const [i, p] of r.points.entries()) {
      if (exclude && exclude.room === r && exclude.idx === i) continue;
      if (Math.abs(p[0] - x) < align) x = p[0];
      if (Math.abs(p[1] - y) < align) y = p[1];
    }
    return [x, y];
  }

  // ---------- rooms ----------
  function createRoom(points) {
    api.checkpoint();
    const layer = roomsLayer();
    if (layer.visible === false) layer.visible = true;
    const n = d.rooms.length + 1;
    const room = { id: uid(), layer: layer.id, name: `Room ${n}`, type: 'bedroom', points, features: [] };
    d.rooms.push(room);
    draft = null;
    api.setTool('select');
    st.selection = [{ kind: 'room', id: room.id }];
    api.changed();
    swallowNextClick();
    roomSheet(room, true);
  }

  function finishPoly() {
    if (!draft || draft.mode !== 'poly') return;
    const pts = draft.pts;
    if (pts.length < 3) { ui.toast('A room needs at least three corners'); return; }
    createRoom(pts.map((p) => [p[0], p[1]]));
  }

  function nearestWall(room, wx, wy) {
    const geo = roomGeo(room, d);
    const pr = projectToWalls(geo, wx, wy);
    return pr && pr.dist * geo.ppm <= Math.max(30 / z(), 0.6 * geo.ppm) ? pr : null;
  }

  function featureAt(room, wx, wy) {
    const geo = roomGeo(room, d);
    const tol = 8 / z();
    for (let i = (room.features || []).length - 1; i >= 0; i--) {
      const f = room.features[i];
      const c = featureCorners(geo, f);
      if (!c) continue;
      if (pointInPoly(wx, wy, c)) return f;
      for (let k = 0; k < c.length; k++) {
        const a = c[k], b = c[(k + 1) % c.length];
        if (distToSeg(wx, wy, a[0], a[1], b[0], b[1]).d <= tol) return f;
      }
    }
    return null;
  }

  function addFeature(room, kind, wall, t0, t1) {
    const def = FEATURE_KINDS[kind];
    const geo = roomGeo(room, d);
    const w = geo.walls[wall];
    let a = Math.min(t0, t1), b = Math.max(t0, t1);
    if (b - a < 0.15) { a = t0 - def.widthM / 2; b = t0 + def.widthM / 2; }
    const width = Math.min(w.lenM, b - a);
    const f = { id: uid(), kind, wall, atM: Math.max(0, Math.min(w.lenM - width, a)), widthM: Math.round(width * 1000) / 1000 };
    if (def.depthM) f.depthM = def.depthM;
    if (kind === 'door') { f.hinge = 'start'; f.swing = 'in'; f.entry = true; }
    api.checkpoint();
    room.features ||= [];
    room.features.push(f);
    api.changed();
    return f;
  }

  // ---------- pointer handlers (return true when the event was ours) ----------
  function down(e, wx, wy) {
    // ghosts first: tap to pick, drag to nudge
    if (ghosts.length) {
      const r = Math.max(16, 20 / z());
      const g = [...ghosts].reverse().find((q) => Math.hypot(q.x - wx, q.y - wy) <= r);
      if (g) { drag = { type: 'ghost', g, last: [wx, wy], moved: false }; return true; }
    }
    if (findings.length && (panelOpen || codeOptions().live)) {
      const r = 13 / z();
      const f = findings.find((q) => Math.hypot(q.at.x - wx, q.at.y - wy) <= r);
      if (f) { focusFinding(f, false); return true; }
    }
    if (st.tool === 'room') {
      const p = snap(wx, wy, { prev: draft?.mode === 'poly' ? draft.pts[draft.pts.length - 1] : null });
      if (st.roomMode === 'rect') { draft = { mode: 'rect', a: p, b: p }; return true; }
      if (!draft) { draft = { mode: 'poly', pts: [p], hover: p }; api.updateChrome(); return true; }
      const first = draft.pts[0], last = draft.pts[draft.pts.length - 1];
      if (draft.pts.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) <= 14 / z()) { finishPoly(); return true; }
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) <= 6 / z()) { if (draft.pts.length >= 3) finishPoly(); return true; }
      draft.pts.push(p);
      api.updateChrome();
      return true;
    }
    const room = selectedRoom();
    if (featureKind && room) {
      if (featureKind === 'island') {
        if (!pointInPoly(wx, wy, room.points)) { ui.toast(`Tap inside ${room.name}`); return true; }
        api.checkpoint();
        const f = { id: uid(), kind: 'island', x: wx, y: wy, lengthM: FEATURE_KINDS.island.lengthM, depthM: FEATURE_KINDS.island.depthM, rotation: 0, fixed: true };
        room.features.push(f);
        featureKind = null;
        api.changed();
        swallowNextClick();
        featureSheet(room, f);
        return true;
      }
      const pr = nearestWall(room, wx, wy);
      if (!pr) { ui.toast(`Tap on a wall of ${room.name}`); return true; }
      drag = { type: 'featureDraw', room, wall: pr.wall, t0: pr.t, t1: pr.t };
      return true;
    }
    if (st.tool === 'select' && room) {
      // a symbol on top of a counter or fixture is selected, not the fixture under it
      const hit = hitTest(d, wx, wy, 6 / z(), api.usable);
      if (hit && hit.kind !== 'room') return false;
      const hr = 12 / z();
      const idx = room.points.findIndex((p) => Math.hypot(p[0] - wx, p[1] - wy) <= hr);
      if (idx >= 0) { drag = { type: 'vertex', room, idx, cp: false }; return true; }
      const f = featureAt(room, wx, wy);
      if (f) {
        const geo = roomGeo(room, d);
        const grab = f.kind === 'island' ? null : projectToWalls(geo, wx, wy);
        drag = { type: 'feature', room, f, cp: false, moved: false, last: [wx, wy], grab: grab && f.wall === grab.wall ? grab.t - featureSpan(geo, f).a : null };
        return true;
      }
    }
    return false;
  }

  function move(e, wx, wy, pressed) {
    if (draft?.mode === 'rect' && pressed) { draft.b = snap(wx, wy); return true; } // no square-up: it would flatten the rectangle
    if (draft?.mode === 'poly') { draft.hover = snap(wx, wy, { prev: draft.pts[draft.pts.length - 1] }); return true; }
    if (!drag) return false;
    if (drag.type === 'ghost') {
      const dx = wx - drag.last[0], dy = wy - drag.last[1];
      if (!drag.moved && Math.hypot(dx, dy) < 4 / z()) return true;
      drag.moved = true;
      drag.g.x += dx; drag.g.y += dy;
      drag.last = [wx, wy];
      return true;
    }
    if (drag.type === 'featureDraw') {
      const geo = roomGeo(drag.room, d);
      const w = geo.walls[drag.wall];
      const u = ((wx - w.a[0]) * w.u[0] + (wy - w.a[1]) * w.u[1]) / geo.ppm;
      drag.t1 = Math.max(0, Math.min(w.lenM, u));
      return true;
    }
    if (drag.type === 'vertex') {
      if (!drag.cp) { api.checkpoint(); drag.cp = true; }
      drag.room.points[drag.idx] = snap(wx, wy, { exclude: { room: drag.room, idx: drag.idx } });
      api.changed();
      return true;
    }
    if (drag.type === 'feature') {
      const dx = wx - drag.last[0], dy = wy - drag.last[1];
      if (!drag.moved && Math.hypot(dx, dy) < 4 / z()) return true;
      if (!drag.cp) { api.checkpoint(); drag.cp = true; }
      drag.moved = true;
      const f = drag.f;
      if (f.kind === 'island') { f.x += dx; f.y += dy; } else {
        const geo = roomGeo(drag.room, d);
        const w = geo.walls[f.wall];
        const u = ((wx - w.a[0]) * w.u[0] + (wy - w.a[1]) * w.u[1]) / geo.ppm;
        const width = featureSpan(geo, f).b - featureSpan(geo, f).a;
        const step = units() === 'imperial' ? 0.0254 : 0.01;
        f.atM = Math.round(Math.max(0, Math.min(w.lenM - width, u - (drag.grab ?? width / 2))) / step) * step;
      }
      drag.last = [wx, wy];
      api.changed();
      return true;
    }
    return false;
  }

  function up() {
    if (draft?.mode === 'rect') {
      const { a, b } = draft;
      const m = ppm();
      if (Math.abs(b[0] - a[0]) / m >= 0.3 && Math.abs(b[1] - a[1]) / m >= 0.3) createRoom(rectPoints(a, b));
      else { draft = null; ui.toast('Drag out the room: corner to corner'); }
      return true;
    }
    if (draft?.mode === 'poly') return true;
    if (!drag) return false;
    const cur = drag;
    drag = null;
    if (cur.type === 'ghost') {
      if (!cur.moved) {
        cur.g.picked = !cur.g.picked;
        const refs = [...new Set(cur.g.ruleRefs.map(ruleLabel))];
        if (cur.g.picked) ui.toast(`${cur.g.reason}${refs.length ? ' (' + refs.join(', ') + ')' : ''}`, 'info', 4000);
      }
      api.updateChrome();
      return true;
    }
    if (cur.type === 'featureDraw') {
      const kind = featureKind;
      const f = addFeature(cur.room, kind, cur.wall, cur.t0, cur.t1);
      if (kind !== 'door' && kind !== 'window' && kind !== 'opening') featureKind = null;
      api.updateChrome();
      ui.toast(`${FEATURE_KINDS[kind].label} added · tap it to edit${featureKind ? '; tap another wall to add more' : ''}`);
      if (!featureKind) { swallowNextClick(); featureSheet(cur.room, f); }
      return true;
    }
    if (cur.type === 'feature' && !cur.moved) { swallowNextClick(); featureSheet(cur.room, cur.f); }
    if (cur.type === 'vertex' || cur.type === 'feature') api.changed();
    return true;
  }

  function key(e) {
    const k = e.key;
    if (k === 'Escape') {
      if (draft || featureKind || ghosts.some((g) => g.picked)) {
        draft = null; featureKind = null; ghosts.forEach((g) => { g.picked = false; });
        api.updateChrome(); api.requestFrame();
        return true;
      }
    }
    if (k === 'Enter' && draft?.mode === 'poly') { finishPoly(); return true; }
    if ((k === 'Backspace' || k === 'Delete') && draft?.mode === 'poly') {
      draft.pts.pop();
      if (!draft.pts.length) draft = null;
      api.updateChrome(); api.requestFrame();
      return true;
    }
    return false;
  }

  /** A second finger turned the gesture into a pinch: drop a half-dragged rectangle or item. */
  function cancelGesture() {
    if (draft?.mode === 'rect') draft = null;
    if (drag?.type === 'featureDraw' || drag?.type === 'ghost') drag = null;
  }

  function toolChanged() {
    draft = null;
    if (st.tool !== 'select') featureKind = null;
  }

  // ---------- overlay ----------
  function overlay(g) {
    const zz = z();
    const dark = api.isDark();
    g.save();
    // selected room: outline and corner handles
    const room = selectedRoom();
    if (room) {
      g.strokeStyle = ACCENT; g.lineWidth = 2 / zz;
      g.beginPath(); room.points.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
      if (st.tool === 'select') {
        const s = 9 / zz;
        g.fillStyle = dark ? '#202226' : '#fbfaf7';
        for (const p of room.points) { g.fillRect(p[0] - s / 2, p[1] - s / 2, s, s); g.strokeRect(p[0] - s / 2, p[1] - s / 2, s, s); }
      }
    }
    // drawing a room
    if (draft) {
      g.strokeStyle = ACCENT; g.lineWidth = 2 / zz; g.setLineDash([6 / zz, 4 / zz]);
      if (draft.mode === 'rect') {
        const pts = rectPoints(draft.a, draft.b);
        g.fillStyle = 'rgba(245,179,1,0.08)';
        g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill(); g.stroke();
        g.setLineDash([]);
        const m = ppm();
        const wM = Math.abs(draft.b[0] - draft.a[0]) / m, hM = Math.abs(draft.b[1] - draft.a[1]) / m;
        api.label(g, draft.b, `${fmt(wM)} × ${fmt(hM)}`);
      } else {
        const pts = [...draft.pts, draft.hover].filter(Boolean);
        g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
        g.setLineDash([]);
        const f0 = draft.pts[0];
        g.beginPath(); g.arc(f0[0], f0[1], 7 / zz, 0, Math.PI * 2); g.stroke();
        if (draft.hover && draft.pts.length) {
          const last = draft.pts[draft.pts.length - 1];
          api.label(g, draft.hover, fmt(Math.hypot(draft.hover[0] - last[0], draft.hover[1] - last[1]) / ppm()));
        }
      }
    }
    if (snapMark && (draft || drag?.type === 'vertex')) {
      g.strokeStyle = ACCENT; g.lineWidth = 2 / zz;
      g.beginPath(); g.arc(snapMark[0], snapMark[1], 9 / zz, 0, Math.PI * 2); g.stroke();
    }
    // a feature being dragged out along a wall
    if (drag?.type === 'featureDraw') {
      const geo = roomGeo(drag.room, d);
      const a = Math.min(drag.t0, drag.t1), b = Math.max(drag.t0, drag.t1);
      const p = wallPoint(geo, drag.wall, a, 0), q = wallPoint(geo, drag.wall, b, 0);
      g.strokeStyle = ACCENT; g.lineWidth = 6 / zz; g.lineCap = 'round';
      g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0] + 0.01, q[1]); g.stroke();
      if (b - a >= 0.15) api.label(g, q, fmt(b - a));
    }
    // ghosts
    for (const q of ghosts) {
      g.globalAlpha = 0.5;
      drawObject(g, { ...q, flags: q.flags }, { dark });
      g.globalAlpha = 1;
      g.strokeStyle = ACCENT; g.lineWidth = (q.picked ? 2.5 : 1.2) / zz;
      g.setLineDash(q.picked ? [] : [4 / zz, 3 / zz]);
      g.beginPath(); g.arc(q.x, q.y, Math.max(17, 18 / zz), 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    // findings
    if (panelOpen || codeOptions().live) {
      findings.forEach((f, i) => {
        const r = (f.id === selFinding ? 13 : 10) / zz;
        g.fillStyle = SEV_COLOR[f.severity];
        g.beginPath(); g.arc(f.at.x, f.at.y, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.5 / zz; g.stroke();
        if (f.id === selFinding) { g.strokeStyle = SEV_COLOR[f.severity]; g.lineWidth = 2 / zz; g.beginPath(); g.arc(f.at.x, f.at.y, r + 5 / zz, 0, Math.PI * 2); g.stroke(); }
        g.fillStyle = '#ffffff'; g.font = `700 ${10 / zz}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(i + 1), f.at.x, f.at.y + 0.5 / zz);
      });
    }
    g.restore();
  }

  // ---------- context bar ----------
  function ctxParts() {
    const chip = (label, fn, on) => h('button', { class: ['cv-chip', on ? 'on' : null], type: 'button', onClick: fn }, label);
    const lab = (t) => h('span', { class: 'cv-ctx-label' }, t);
    if (ghosts.length) {
      const picked = ghosts.filter((g) => g.picked);
      const one = picked.length === 1 ? picked[0] : null;
      return [
        lab(one ? `${SYMBOLS[one.symbol]?.label || one.symbol}${one.ruleRefs.length ? ' · ' + ruleLabel(one.ruleRefs[0]) : ''}`
          : `${ghosts.length} proposed${picked.length ? ` · ${picked.length} picked` : ' · tap to pick, drag to nudge'}`),
        picked.length ? chip('Accept picked', () => accept(picked)) : null,
        picked.length ? chip('Discard picked', () => discard(picked)) : null,
        chip('Discard all', () => discard(ghosts)),
        chip('Accept all', () => accept(ghosts), true),
      ];
    }
    if (st.tool === 'room') {
      const parts = [lab(draft?.mode === 'poly' ? `${draft.pts.length} corner${draft.pts.length === 1 ? '' : 's'} · tap the first corner to close` : st.roomMode === 'rect' ? 'Room: drag corner to corner' : 'Room: tap each corner'),
        chip('Rectangle', () => { st.roomMode = 'rect'; draft = null; api.updateChrome(); }, st.roomMode === 'rect'),
        chip('Polygon', () => { st.roomMode = 'poly'; draft = null; api.updateChrome(); }, st.roomMode === 'poly')];
      if (draft?.mode === 'poly') {
        parts.push(chip('Undo corner', () => { draft.pts.pop(); if (!draft.pts.length) draft = null; api.updateChrome(); api.requestFrame(); }),
          chip('Cancel', () => { draft = null; api.updateChrome(); api.requestFrame(); }));
        if (draft && draft.pts.length >= 3) parts.push(chip('Close room', () => finishPoly(), true));
      }
      return parts;
    }
    const room = selectedRoom();
    if (room && featureKind) {
      return [lab(featureKind === 'island' ? `Tap inside ${room.name} to add an island` : `Tap a wall to add: ${FEATURE_KINDS[featureKind].label.toLowerCase()} (drag along it for the width)`),
        chip('Done', () => { featureKind = null; api.updateChrome(); }, true)];
    }
    if (room) {
      return [lab(`${room.name} · ${roomSizeLabel(room, d, units())}`),
        chip('Edit', () => roomSheet(room)),
        chip('Add door, window…', () => addFeatureSheet(room)),
        chip('Check', () => openCheck()),
        chip('Auto-place', () => autoPlace([room.id]), true)];
    }
    return null;
  }

  // ---------- auto-place ----------
  function autoPlace(roomIds) {
    if (!d.rooms.length) { ui.toast('Draw a room first (Room tool, O)', 'error'); return; }
    const opts = { settings: settings(), codeOptions: codeOptions() };
    const model = buildModel(d, opts.settings);
    const props = roomIds ? roomIds.flatMap((id) => proposeRoom(d, id, { ...opts, model })) : proposeAll(d, { ...opts, model });
    ghosts = props.map((p) => ({ ...p, picked: false }));
    if (!ghosts.length) ui.toast('Nothing to add: the boxes already meet the placement rules', 'success');
    else ui.toast(`${ghosts.length} boxes proposed. Accept all, or tap to pick some.`);
    st.selection = [];
    if (st.tool !== 'select' && st.tool !== 'hand') api.setTool('select');
    api.updateChrome(); api.requestFrame();
  }

  function accept(list) {
    if (!list.length) return;
    api.checkpoint();
    const layer = deviceLayer();
    const placed = [];
    for (const g of list) {
      const o = { id: uid(), layer, symbol: g.symbol, x: g.x, y: g.y, rotation: g.rotation || 0, scale: 1, roomId: g.roomId, auto: true };
      // keep the marks that apply (and co: false, which means smoke-only)
      const flags = Object.fromEntries(Object.entries(g.flags || {}).filter(([k, v]) => v === true || (k === 'co' && v === false)));
      if (Object.keys(flags).length) o.flags = flags;
      if (g.mountM != null) o.mountM = Math.round(g.mountM * 1000) / 1000;
      if (g.ruleRefs?.length) o.rules = [...new Set(g.ruleRefs.map(ruleLabel))];
      d.objects.push(o);
      placed.push(o);
    }
    const gone = new Set(list);
    ghosts = ghosts.filter((g) => !gone.has(g));
    api.changed();
    ui.toast(`Placed ${placed.length} box${placed.length === 1 ? '' : 'es'}. They count in the takeoff.`, 'success');
  }
  function discard(list) {
    const gone = new Set(list);
    ghosts = ghosts.filter((g) => !gone.has(g));
    api.updateChrome(); api.requestFrame();
  }

  // ---------- code check ----------
  const panelList = h('div', { class: 'cv-findings-list' });
  const panelSummary = h('div', { class: 'cv-findings-sum' });
  const liveBox = h('input', { type: 'checkbox', onChange: (e) => { d.codeOptions = { ...codeOptions(), live: e.target.checked }; api.changed(); } });
  const panel = h('aside', { class: 'cv-findings', hidden: true, 'aria-label': 'Code check findings' },
    h('header', { class: 'cv-findings-head' },
      h('div', { class: 'grow' }, h('strong', null, 'Code check'), h('div', { class: 'cv-findings-book' }, 'CEC 2024 (CSA C22.1:24) · alarms and lights: NBC 2020')),
      h('button', { class: 'cv-btn', type: 'button', title: 'Close', 'aria-label': 'Close code check', onClick: () => closeCheck() }, icon('x', 18))),
    h('div', { class: 'cv-findings-bar' }, panelSummary,
      h('label', { class: 'cv-findings-live', title: 'Re-check after every change' }, liveBox, h('span', null, 'Live')),
      h('button', { class: 'cv-chip', type: 'button', onClick: () => runCheck() }, 'Re-check')),
    panelList,
    h('footer', { class: 'cv-findings-foot' }, 'An aid, not an inspection. Rules marked VERIFY are not confirmed against the 2024 text; provinces amend the code.'));
  api.wrap.append(panel);

  function runCheck() {
    findings = checkDrawing(d, { settings: settings(), codeOptions: codeOptions(), units: units() });
    if (selFinding && !findings.some((f) => f.id === selFinding)) selFinding = null;
    renderPanel();
    api.requestFrame();
    return findings;
  }
  function openCheck() {
    panelOpen = true;
    panel.hidden = false;
    if (!d.rooms.length) ui.toast('Draw rooms (Room tool, O) so the check knows where the walls are');
    runCheck();
  }
  function closeCheck() { panelOpen = false; panel.hidden = true; selFinding = null; api.requestFrame(); }

  function renderPanel() {
    liveBox.checked = !!codeOptions().live;
    ui.clear(panelSummary);
    const s = summarize(findings);
    panelSummary.append(...['error', 'warning', 'info'].filter((k) => s[k]).map((k) => h('span', { class: ['cv-sev', k] }, `${s[k]} ${SEV_LABEL[k].toLowerCase()}`)));
    if (!findings.length) panelSummary.append(h('span', { class: 'cv-sev ok' }, d.rooms.length ? 'No findings' : 'No rooms yet'));
    ui.clear(panelList);
    const roomName = new Map(d.rooms.map((r) => [r.id, r.name]));
    findings.forEach((f, i) => {
      const fix = f.fix ? h('button', { class: 'cv-chip', type: 'button', onClick: (e) => { e.stopPropagation(); applyFix(f); } }, f.fix.label) : null;
      panelList.append(h('div', { class: ['cv-finding', f.severity, f.id === selFinding ? 'on' : null], role: 'button', tabindex: 0,
        onClick: () => focusFinding(f, true), onKeydown: (e) => { if (e.key === 'Enter') focusFinding(f, true); } },
      h('span', { class: ['cv-finding-n', f.severity] }, String(i + 1)),
      h('div', { class: 'grow' },
        h('div', { class: 'cv-finding-msg' }, f.message),
        h('div', { class: 'cv-finding-meta' }, h('span', { class: 'cv-rule' }, f.ruleRef), f.verify ? h('span', { class: 'cv-verify', title: RULES[f.ruleId]?.verify || '' }, 'VERIFY') : null,
          h('span', null, `${SEV_LABEL[f.severity]}${roomName.get(f.roomId) ? '' : ''}`))),
      fix));
    });
  }

  function focusFinding(f, zoom) {
    selFinding = f.id;
    if (zoom) api.centerOn(f.at.x, f.at.y, Math.max(api.z(), 1.4));
    if (!panelOpen) { panelOpen = true; panel.hidden = false; }
    renderPanel();
    panelList.querySelector('.cv-finding.on')?.scrollIntoView?.({ block: 'nearest' });
    api.requestFrame();
  }

  function applyFix(f) {
    const objs = d.objects.filter((o) => f.fix.objectIds.includes(o.id));
    if (!objs.length) return;
    api.checkpoint();
    for (const o of objs) {
      if (f.fix.symbol) o.symbol = f.fix.symbol;
      if (f.fix.flags) o.flags = { ...(o.flags || {}), ...f.fix.flags };
    }
    api.changed();
    runCheck();
    ui.toast(`${f.fix.label}: ${objs.length} updated`, 'success');
  }

  /** Called by the editor after every content change. */
  function onChanged() {
    if (!(panelOpen || codeOptions().live)) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => runCheck(), 300);
  }

  // ---------- sheets ----------
  function lenField(label, name, m, hint) {
    return { label: `${label} (${units() === 'imperial' ? 'ft-in' : 'm or mm'})`, name, value: m == null ? '' : fmtLength(m, { units: units(), denom: 16 }), hint };
  }
  function isRect(room) {
    if (room.points.length !== 4) return false;
    const w = roomGeo(room, d).walls;
    return w.every((x, i) => Math.abs(x.u[0] * w[(i + 1) % 4].u[0] + x.u[1] * w[(i + 1) % 4].u[1]) < 0.02);
  }

  function roomSheet(room, isNew = false) {
    const geo = roomGeo(room, d);
    const rect = isRect(room);
    const fields = [
      { label: 'Name', name: 'name', value: room.name, required: true },
      { label: 'Room type', name: 'type', type: 'select', value: room.type, options: ROOM_TYPE_ORDER.map((t) => ({ value: t, label: ROOM_TYPES[t].label })) },
      { label: 'Lighting', name: 'lighting', type: 'select', value: room.lighting || '', options: [
        { value: '', label: 'Default for the room type' }, { value: 'ceiling', label: 'Ceiling light' }, { value: 'recessed', label: 'Recessed grid' },
        { value: 'wall', label: 'Wall lights' }, { value: 'switched-receptacle', label: 'Switched receptacle' }, { value: 'none', label: 'None' }] },
    ];
    if (rect) fields.push(lenField('Width', 'w', geo.walls[0].lenM), lenField('Depth', 'h', geo.walls[1].lenM));
    fields.push({ label: 'Car spaces (garage)', name: 'carSpaces', type: 'number', min: 0, step: 1, value: room.carSpaces ?? '', hint: 'Garages need a receptacle for each car space (CEC 26-724 b), VERIFY).' });
    fields.push(lenField('Height above grade (outdoor)', 'aboveGrade', room.aboveGradeM ?? 0, 'Over 2.5 m (an upper balcony) means no GFCI is required by 26-704 2).'));
    const defaultName = room.name;
    const sheet = ui.formSheet({
      title: isNew ? 'New room' : 'Room',
      fields,
      submitLabel: isNew ? 'Save room' : 'Save',
      danger: isNew ? null : { label: 'Delete room', onClick: () => { api.checkpoint(); d.rooms = d.rooms.filter((r) => r !== room); st.selection = []; api.changed(); } },
      onSubmit: (v) => {
        let wM = null, hM = null;
        if (rect) {
          wM = readLen(v.w); hM = readLen(v.h);
          if (!(wM > 0.2) || !(hM > 0.2)) { ui.toast('Enter a width and depth, e.g. 4.2 m or 13\' 6"', 'error'); return false; }
        }
        const above = readLen(v.aboveGrade);
        api.checkpoint();
        // a new room still called "Room 3" takes its type's name: Kitchen, Bedroom 2
        let name = v.name.trim() || room.name;
        if (isNew && name === defaultName) {
          const label = ROOM_TYPES[v.type].label.split(' / ')[0];
          const same = d.rooms.filter((r) => r !== room && r.type === v.type).length;
          name = same ? `${label} ${same + 1}` : label;
        }
        room.name = name;
        room.type = v.type;
        if (v.lighting) room.lighting = v.lighting; else delete room.lighting;
        if (Number(v.carSpaces) > 0) room.carSpaces = Math.round(Number(v.carSpaces)); else delete room.carSpaces;
        if (above > 0) room.aboveGradeM = above; else delete room.aboveGradeM;
        if (rect && (Math.abs(wM - geo.walls[0].lenM) > 0.001 || Math.abs(hM - geo.walls[1].lenM) > 0.001)) {
          const w0 = geo.walls[0], m = geo.ppm;
          const p0 = room.points[0];
          const p1 = [p0[0] + w0.u[0] * wM * m, p0[1] + w0.u[1] * wM * m];
          room.points = [p0, p1, [p1[0] + w0.n[0] * hM * m, p1[1] + w0.n[1] * hM * m], [p0[0] + w0.n[0] * hM * m, p0[1] + w0.n[1] * hM * m]];
        }
        api.changed();
      },
    });
    // car spaces only for garages, height above grade only outdoors
    const typeSel = sheet.el.querySelector('select[name=type]');
    const toggle = () => {
      const t = ROOM_TYPES[typeSel.value] || {};
      sheet.el.querySelector('[name=carSpaces]')?.closest('.field')?.toggleAttribute('hidden', !t.garage);
      sheet.el.querySelector('[name=aboveGrade]')?.closest('.field')?.toggleAttribute('hidden', !t.outdoor);
    };
    typeSel?.addEventListener('change', toggle);
    toggle();
  }

  function addFeatureSheet(room) {
    const s = ui.openSheet({
      title: `Add to ${room.name}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Pick one, then tap a wall (drag along it to set the width). Doors and windows stay picked so you can add several.'),
        h('div', { class: 'cv-feature-grid' }, FEATURE_ORDER.map((k) => h('button', { type: 'button', class: 'cv-feature',
          onClick: () => { featureKind = k; s.close(); api.updateChrome(); api.requestFrame(); } },
        h('strong', null, FEATURE_KINDS[k].label),
        h('small', { class: 'muted' }, k === 'island' ? 'Tap inside' : FEATURE_KINDS[k].blocks ? 'Not usable wall' : 'Usable wall below'))))),
    });
  }

  function featureSheet(room, f) {
    const geo = roomGeo(room, d);
    const kind = FEATURE_KINDS[f.kind];
    const fields = [];
    if (f.kind === 'island') {
      fields.push(lenField('Length', 'lengthM', f.lengthM), lenField('Depth', 'depthM', f.depthM),
        { label: 'Rotation (degrees)', name: 'rotation', type: 'number', step: 'any', value: f.rotation || 0 },
        { label: 'Peninsula (joined to a wall or counter)', name: 'peninsula', type: 'checkbox', value: !!f.peninsula },
        { label: 'Has a sink', name: 'sink', type: 'checkbox', value: !!f.sink },
        { label: 'Permanently fixed', name: 'fixed', type: 'checkbox', value: f.fixed !== false });
    } else {
      const sp = featureSpan(geo, f);
      const w = geo.walls[f.wall];
      // left/right as you face this wall from inside the room
      const startIsLeft = (w.n[1] * w.u[0] - w.n[0] * w.u[1]) > 0;
      fields.push(lenField('Width', 'widthM', sp.b - sp.a), lenField('From the wall\'s start corner', 'atM', sp.a, `This wall is ${fmt(w.lenM)}. You can also drag the item along the wall.`));
      if (kind.depthM) fields.push(lenField('Depth into the room', 'depthM', f.depthM ?? kind.depthM));
      if (f.kind === 'door') {
        fields.push({ label: 'Hinge side (facing the door from inside)', name: 'hinge', type: 'select', value: f.hinge === 'end' ? 'end' : 'start',
          options: [{ value: 'start', label: startIsLeft ? 'Left' : 'Right' }, { value: 'end', label: startIsLeft ? 'Right' : 'Left' }] },
        { label: 'Swing', name: 'swing', type: 'select', value: f.swing === 'out' ? 'out' : 'in', options: [{ value: 'in', label: 'Into this room' }, { value: 'out', label: 'Out of this room' }] },
        { label: 'Entry: put a switch on the latch side', name: 'entry', type: 'checkbox', value: f.entry !== false });
      }
      if (f.kind === 'opening') fields.push({ label: 'Entry: put a switch beside it', name: 'entry', type: 'checkbox', value: !!f.entry });
      if (f.kind === 'window') fields.push({ label: 'Goes to the floor (not usable wall)', name: 'toFloor', type: 'checkbox', value: !!f.toFloor });
      if (f.kind === 'range') fields.push({ label: 'Gas range (needs a 120 V receptacle behind it)', name: 'gas', type: 'checkbox', value: !!f.gas });
    }
    ui.formSheet({
      title: kind.label,
      fields,
      danger: { label: 'Remove', onClick: () => { api.checkpoint(); room.features = room.features.filter((x) => x !== f); api.changed(); } },
      onSubmit: (v) => {
        const vals = {};
        for (const k of ['widthM', 'atM', 'depthM', 'lengthM']) {
          if (!(k in v)) continue;
          const m = readLen(v[k]);
          if (m == null || m < 0 || (k !== 'atM' && m <= 0)) { ui.toast(`Check the ${k === 'atM' ? 'position' : k.replace('M', '')}`, 'error'); return false; }
          vals[k] = Math.round(m * 1000) / 1000;
        }
        api.checkpoint();
        Object.assign(f, vals);
        for (const k of ['hinge', 'swing', 'entry', 'toFloor', 'gas', 'peninsula', 'sink']) if (k in v) f[k] = v[k];
        if ('fixed' in v) f.fixed = v.fixed;
        if ('rotation' in v) f.rotation = Number(v.rotation) || 0;
        api.changed();
      },
    });
  }

  function settingsSheet() {
    const S = settings();
    const canCompany = api.auth?.can?.('settings');
    const fields = [
      lenField('Receptacle height to centre', 'receptacleHeightM', S.receptacleHeightM),
      lenField('Counter receptacle height', 'counterHeightM', S.counterHeightM),
      lenField('Switch height to centre', 'switchHeightM', S.switchHeightM, 'Company practice, not code.'),
      lenField('Switch from the latch jamb', 'switchFromJambM', S.switchFromJambM),
      lenField('Recessed light spacing', 'recessedSpacingM', S.recessedSpacingM),
      { label: 'Wall behind an open door is not usable (26-722 c))', name: 'excludeDoorSwing', type: 'checkbox', value: S.excludeDoorSwing },
      { label: '3-way switches when a room has two or more entries', name: 'threeWay', type: 'checkbox', value: S.threeWay },
      { label: 'Smoke alarm in each bedroom (NBC 9.10.19.3)', name: 'alarmBedrooms', type: 'checkbox', value: S.alarms.bedrooms },
      { label: 'Smoke alarm in hallways serving bedrooms', name: 'alarmHallways', type: 'checkbox', value: S.alarms.hallways },
      { label: 'Smoke alarm in unfinished basements', name: 'alarmBasement', type: 'checkbox', value: S.alarms.basement },
      { label: 'This house has a fuel-burning appliance or attached garage (CO alarms, NBC 9.32.3.9)', name: 'fuelBurning', type: 'checkbox', value: !!codeOptions().fuelBurning, span: true },
      { label: 'Live check: re-check after every change', name: 'live', type: 'checkbox', value: !!codeOptions().live },
    ];
    if (canCompany) fields.push({ label: 'Make these heights and alarm rules the company default', name: 'company', type: 'checkbox', value: false, span: true });
    ui.formSheet({
      title: 'Placement & check settings',
      fields,
      onSubmit: (v) => {
        const p = {};
        for (const k of ['receptacleHeightM', 'counterHeightM', 'switchHeightM', 'switchFromJambM', 'recessedSpacingM']) {
          const m = readLen(v[k]);
          if (m == null || m < 0) { ui.toast('Check the lengths', 'error'); return false; }
          p[k] = Math.round(m * 1000) / 1000;
        }
        p.excludeDoorSwing = v.excludeDoorSwing; p.threeWay = v.threeWay;
        p.alarms = { bedrooms: v.alarmBedrooms, hallways: v.alarmHallways, basement: v.alarmBasement };
        api.checkpoint();
        if (v.company) { store.saveSettings({ placement: { ...(store.settings().placement || {}), ...p } }); delete d.placement; }
        else d.placement = p;
        d.codeOptions = { ...codeOptions(), fuelBurning: v.fuelBurning, live: v.live };
        api.changed();
        if (panelOpen) runCheck();
        ui.toast(v.company ? 'Saved as the company default' : 'Saved for this drawing', 'success');
      },
    });
  }

  /** Protection marks and mounting height for selected symbols. */
  function deviceSheet(objs) {
    if (!objs.length) return;
    const all = (k) => objs.every((o) => o.flags?.[k]);
    const recs = objs.some((o) => o.symbol.startsWith('receptacle'));
    const fields = recs ? [
      { label: 'GFCI protected (or use the GFCI symbol)', name: 'gfci', type: 'checkbox', value: all('gfci') },
      { label: 'AFCI (combination type on the circuit)', name: 'afci', type: 'checkbox', value: all('afci') },
      { label: 'Tamper-resistant', name: 'tr', type: 'checkbox', value: all('tr') },
      { label: 'Weatherproof / in-use cover', name: 'wp', type: 'checkbox', value: all('wp') },
      { label: 'Switched (counts as the room light)', name: 'switched', type: 'checkbox', value: all('switched') },
    ] : [];
    if (objs.some((o) => o.symbol === 'smoke')) fields.push({ label: 'Smoke only (no CO)', name: 'smokeOnly', type: 'checkbox', value: objs.every((o) => o.flags?.co === false) });
    const heights = objs.map((o) => o.mountM).filter((x) => x != null);
    fields.push(lenField('Mounting height to centre', 'mountM', heights.length === objs.length && heights.every((x) => x === heights[0]) ? heights[0] : null, 'Leave blank to keep each one\'s height.'));
    ui.formSheet({
      title: objs.length === 1 ? (SYMBOLS[objs[0].symbol]?.label || 'Device') : `${objs.length} devices`,
      fields,
      onSubmit: (v) => {
        const m = String(v.mountM || '').trim() ? readLen(v.mountM) : null;
        if (String(v.mountM || '').trim() && m == null) { ui.toast('Check the height', 'error'); return false; }
        api.checkpoint();
        for (const o of objs) {
          const f = { ...(o.flags || {}) };
          if (recs && o.symbol.startsWith('receptacle')) for (const k of ['gfci', 'afci', 'tr', 'wp', 'switched']) { if (v[k]) f[k] = true; else delete f[k]; }
          if (o.symbol === 'smoke' && 'smokeOnly' in v) { if (v.smokeOnly) f.co = false; else delete f.co; }
          if (Object.keys(f).length) o.flags = f; else delete o.flags;
          if (m != null) o.mountM = Math.round(m * 1000) / 1000;
        }
        api.changed();
      },
    });
  }

  function destroy() { clearTimeout(liveTimer); panel.remove(); }

  return {
    down, move, up, key, overlay, ctxParts, toolChanged, onChanged, cancelGesture,
    openCheck, closeCheck, runCheck, autoPlace, settingsSheet, roomSheet, deviceSheet, destroy,
    get ghosts() { return ghosts; }, get findings() { return findings; }, get busy() { return !!draft || !!drag; },
    accept: (ids) => accept(ids ? ghosts.filter((g) => ids.includes(g.id)) : ghosts),
    roomsLayer,
  };
}
