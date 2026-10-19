// Electrical plan symbols, drawn for Kelbe Circuit on a 40-unit box centred
// on 0,0. Each symbol is SVG path data, so the canvas (Path2D) and the SVG
// export draw exactly the same shapes. `fill` parts are filled with the ink
// colour; `text` parts are labels inside or beside the symbol.

const circle = (r, cx = 0, cy = 0) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const SYMBOLS = {
  receptacle: { label: 'Duplex receptacle', parts: [{ d: circle(8) }, { d: 'M-3 -14V14M3 -14V14' }] },
  'receptacle-gfci': { label: 'GFCI receptacle', parts: [{ d: circle(8) }, { d: 'M-3 -14V14M3 -14V14' }], text: [{ t: 'GFCI', x: 0, y: 24, size: 9 }] },
  'receptacle-240': { label: '240V receptacle', parts: [{ d: circle(9) }, { d: 'M-9 0a9 9 0 0 0 18 0z', fill: true }, { d: 'M0 -15V-9' }], text: [{ t: '240', x: 0, y: 24, size: 9 }] },
  switch: { label: 'Single-pole switch', parts: [{ d: 'M-10 14H10' }], text: [{ t: 'S', x: 0, y: 2, size: 22 }] },
  'switch-3way': { label: '3-way switch', parts: [{ d: 'M-12 14H12' }], text: [{ t: 'S', x: -3, y: 2, size: 22 }, { t: '3', x: 9, y: 9, size: 11 }] },
  'switch-dimmer': { label: 'Dimmer', parts: [{ d: 'M-12 14H12' }], text: [{ t: 'S', x: -3, y: 2, size: 22 }, { t: 'D', x: 9, y: 9, size: 11 }] },
  'light-ceiling': { label: 'Ceiling light', parts: [{ d: circle(11) }, { d: 'M-7.8 -7.8L7.8 7.8M7.8 -7.8L-7.8 7.8' }] },
  'light-recessed': { label: 'Recessed light', parts: [{ d: 'M-12 -12h24v24h-24z' }, { d: circle(7) }, { d: circle(2.5), fill: true }] },
  'light-wall': { label: 'Wall sconce', parts: [{ d: 'M-13 6H13' }, { d: 'M-10 6a10 10 0 0 1 20 0' }, { d: 'M-6 -1L6 5M6 -1L-6 5' }] },
  fan: {
    label: 'Ceiling fan', parts: [
      { d: circle(4), fill: true },
      { d: 'M0 -4C5 -10 4 -17 0 -18C-4 -17 -5 -10 0 -4Z M4 0C10 5 17 4 18 0C17 -4 10 -5 4 0Z M0 4C-5 10 -4 17 0 18C4 17 5 10 0 4Z M-4 0C-10 -5 -17 -4 -18 0C-17 4 -10 5 -4 0Z' },
    ],
  },
  smoke: { label: 'Smoke / CO alarm', parts: [{ d: circle(12) }], text: [{ t: 'SC', x: 0, y: 1, size: 11 }] },
  panel: { label: 'Panelboard', parts: [{ d: 'M-18 -8h36v16h-36z' }, { d: 'M-18 8L18 -8V8Z', fill: true }] },
  junction: { label: 'Junction box', parts: [{ d: circle(10) }], text: [{ t: 'J', x: 0, y: 1, size: 13 }] },
  disconnect: { label: 'Disconnect', parts: [{ d: 'M-13 -11h26v22h-26z' }, { d: 'M-7 6L6 -5' }, { d: circle(2, -7, 6), fill: true }, { d: 'M6 6h3' }] },
  'ev-charger': {
    label: 'EV charger', parts: [{ d: 'M-11 -14h22v28h-22z' }, { d: 'M2 -10L-5 1h5l-2 9 7-11h-5z', fill: true }],
    text: [{ t: 'EV', x: 0, y: 24, size: 9 }],
  },
  data: { label: 'Data outlet', parts: [{ d: 'M0 -11L12 9H-12Z' }], text: [{ t: 'D', x: 0, y: 3, size: 10 }] },
  motor: { label: 'Motor', parts: [{ d: circle(12) }], text: [{ t: 'M', x: 0, y: 1, size: 13 }] },
  meter: { label: 'Meter', parts: [{ d: circle(12) }, { d: 'M-12 0H12' }], text: [{ t: 'kWh', x: 0, y: -4, size: 7 }] },
};

export const SYMBOL_ORDER = Object.keys(SYMBOLS);
export const SYMBOL_RADIUS = 20;

const pathCache = new Map();
function path(d) {
  if (!pathCache.has(d)) pathCache.set(d, new Path2D(d));
  return pathCache.get(d);
}

/** Draw a symbol centred on the current origin (apply translate/rotate/scale first). */
export function drawSymbol(ctx, id, color, lineWidth = 2) {
  const s = SYMBOLS[id];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!s) {
    ctx.strokeRect(-10, -10, 20, 20);
    ctx.restore();
    return;
  }
  for (const p of s.parts) {
    const p2 = path(p.d);
    if (p.fill) ctx.fill(p2); else ctx.stroke(p2);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of s.text || []) {
    ctx.font = `700 ${t.size}px Inter, system-ui, sans-serif`;
    ctx.fillText(t.t, t.x, t.y);
  }
  ctx.restore();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** SVG markup (no wrapper) for a symbol centred on 0,0. */
export function symbolSVG(id, color, lineWidth = 2) {
  const s = SYMBOLS[id];
  if (!s) return `<rect x="-10" y="-10" width="20" height="20" fill="none" stroke="${color}"/>`;
  const parts = s.parts.map((p) => p.fill
    ? `<path d="${p.d}" fill="${color}"/>`
    : `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
  const texts = (s.text || []).map((t) => `<text x="${t.x}" y="${t.y}" font-family="Inter, system-ui, sans-serif" font-weight="700" font-size="${t.size}" fill="${color}" text-anchor="middle" dominant-baseline="central">${esc(t.t)}</text>`);
  return parts.join('') + texts.join('');
}

/** A small canvas preview tile for the library sheet. */
export function symbolPreview(id, color, size = 56) {
  const dpr = globalThis.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = size * dpr; c.height = size * dpr;
  c.style.width = c.style.height = size + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(size / 2, size / 2 - 2);
  ctx.scale(size / 52, size / 52);
  drawSymbol(ctx, id, color);
  return c;
}
