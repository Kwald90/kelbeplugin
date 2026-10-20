// A small slippy map with no library: raster tiles in <img>, an SVG overlay for the site circle,
// pins and dots, drag to pan, buttons to zoom, tap to drop a pin. Used on the job screen (site
// location), in My location (your own points) and on the opt-in crew map.
//
// Tiles: Natural Resources Canada's Canada Base Map – Transportation (CBMT), Web Mercator, under
// the Open Government Licence – Canada (commercial use allowed). Checked 2026-10-19: base layer
// CBMT_CBCT_GEOM_3857 (JPEG) plus the CBMT_TXT_3857 labels (transparent PNG), zoom 0-15, Canada
// only, no key. Closer zooms scale the zoom-15 tiles. Tiles are requested from the browser with no
// referrer; they show where a job is, never where a person is (the overlay is drawn locally).
import { project, unproject, metresPerPixel, TILE } from './geo.js';

export const TILE_BASE = 'https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/CBMT_CBCT_GEOM_3857/MapServer/tile/{z}/{y}/{x}';
export const TILE_LABELS = 'https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/CBMT_TXT_3857/MapServer/tile/{z}/{y}/{x}';
export const TILE_MAX_ZOOM = 15;
export const MAX_ZOOM = 18;
export const MIN_ZOOM = 3;
export const ATTRIBUTION = 'Base map © Natural Resources Canada. Contains information licensed under the Open Government Licence – Canada.';
const SVGNS = 'http://www.w3.org/2000/svg';

export const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/**
 * @param {object} o
 * @param {Function} o.h            ui.h
 * @param {{ lat: number, lng: number }} o.center
 * @param {number} [o.zoom]
 * @param {number} [o.height]       px
 * @param {{ lat, lng, radiusM }} [o.circle]   the job site
 * @param {{ lat, lng, label?, kind?: 'site'|'me'|'crew'|'point', title? }[]} [o.markers]
 * @param {(p: { lat: number, lng: number }) => void} [o.onPick]   tap to drop a pin (managers)
 * @param {string} [o.label]        accessible name
 */
export function miniMap({ h, center, zoom = 16, height = 240, circle = null, markers = [], onPick = null, label = 'Map' }) {
  let c = { ...center };
  let z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
  let w = 0;
  const tiles = h('div', { class: 'mm-tiles' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mm-overlay');
  svg.setAttribute('aria-hidden', 'true');
  const pins = h('div', { class: 'mm-pins' });
  const zoomBtn = (txt, d, name) => h('button', { type: 'button', class: 'mm-zoom', 'aria-label': name, onClick: (e) => { e.stopPropagation(); setZoom(z + d); } }, txt);
  const el = h('div', { class: ['mm', onPick ? 'mm-pick' : null], role: 'application', 'aria-label': label, style: { height: `${height}px` } },
    tiles, svg, pins,
    h('div', { class: 'mm-zooms' }, zoomBtn('+', 1, 'Zoom in'), zoomBtn('−', -1, 'Zoom out')),
    h('div', { class: 'mm-attr' }, ATTRIBUTION));

  const imgCache = new Map();
  function tileImg(tpl, tz, x, y, cls) {
    const key = `${cls}/${tz}/${x}/${y}`;
    if (imgCache.has(key)) return imgCache.get(key);
    const img = h('img', { class: ['mm-tile', cls], alt: '', draggable: 'false', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.classList.add('mm-missing'));
    img.src = tileUrl(tpl, tz, x, y);
    imgCache.set(key, img);
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
    return img;
  }

  function draw() {
    w = el.clientWidth || w || 320;
    const hgt = height;
    const tz = Math.min(z, TILE_MAX_ZOOM);
    const scale = 2 ** (z - tz);
    const size = TILE * scale;
    const mid = project(c.lat, c.lng, z);
    const left = mid.x - w / 2, top = mid.y - hgt / 2;
    const n = 2 ** tz;
    const kids = [];
    for (let ty = Math.floor(top / size); ty <= Math.floor((top + hgt) / size); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / size); tx <= Math.floor((left + w) / size); tx++) {
        const x = ((tx % n) + n) % n;
        for (const [tpl, cls] of [[TILE_BASE, 'mm-base'], [TILE_LABELS, 'mm-labels']]) {
          const img = tileImg(tpl, tz, x, ty, cls);
          Object.assign(img.style, { left: `${Math.round(tx * size - left)}px`, top: `${Math.round(ty * size - top)}px`, width: `${size}px`, height: `${size}px` });
          kids.push(img);
        }
      }
    }
    tiles.replaceChildren(...kids);
    const at = (p) => { const q = project(p.lat, p.lng, z); return { x: q.x - left, y: q.y - top }; };
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(hgt));
    svg.replaceChildren();
    if (circle) {
      const p = at(circle);
      const r = Math.max(4, (circle.radiusM || 0) / metresPerPixel(circle.lat, z));
      const ring = document.createElementNS(SVGNS, 'circle');
      for (const [k, v] of [['cx', p.x], ['cy', p.y], ['r', r], ['class', 'mm-radius']]) ring.setAttribute(k, String(v));
      svg.append(ring);
    }
    pins.replaceChildren(...markers.map((m) => {
      const p = at(m);
      const pin = h('div', { class: ['mm-pin', `mm-${m.kind || 'site'}`], title: m.title || m.label || '' }, m.label ? h('span', { class: 'mm-pin-label' }, m.label) : null);
      Object.assign(pin.style, { left: `${Math.round(p.x)}px`, top: `${Math.round(p.y)}px` });
      return pin;
    }));
  }

  function setZoom(nz) { z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nz)); draw(); }

  // Drag to pan; a tap (little movement) drops a pin when onPick is set.
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mm-zoom')) return;
    drag = { x: e.clientX, y: e.clientY, c: { ...c }, moved: false, id: e.pointerId };
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (!drag.moved) return;
    const p = project(drag.c.lat, drag.c.lng, z);
    c = unproject(p.x - dx, p.y - dy, z);
    draw();
  });
  const end = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    if (d.moved || !onPick || e.type === 'pointercancel') return;
    const r = el.getBoundingClientRect();
    const mid = project(c.lat, c.lng, z);
    const p = unproject(mid.x - w / 2 + (e.clientX - r.left), mid.y - height / 2 + (e.clientY - r.top), z);
    onPick({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { if (el.clientWidth && el.clientWidth !== w) draw(); }); ro.observe(el); }
  requestAnimationFrame(draw);

  return {
    el,
    get center() { return { ...c }; },
    get zoom() { return z; },
    setView(center2, z2) { if (center2) c = { ...center2 }; if (z2) z = z2; draw(); },
    setCircle(next) { circle = next; draw(); },
    setMarkers(next) { markers = next || []; draw(); },
    destroy() { ro?.disconnect(); },
  };
}

/** A zoom that fits a set of points into the map (rough, for the crew map and history). */
export function fitZoom(points, widthPx = 320, heightPx = 240) {
  if (!points?.length) return 12;
  if (points.length === 1) return 16;
  for (let z = 17; z >= MIN_ZOOM; z--) {
    const ps = points.map((p) => project(p.lat, p.lng, z));
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) < widthPx * 0.8 && Math.max(...ys) - Math.min(...ys) < heightPx * 0.8) return z;
  }
  return MIN_ZOOM;
}

export function centerOf(points) {
  if (!points?.length) return { lat: 49.8951, lng: -97.1384 }; // Winnipeg
  return { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
}
