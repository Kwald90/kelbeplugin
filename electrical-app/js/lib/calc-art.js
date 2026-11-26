// Line-art pictures: one clean drawing per thing, so a person finds a tool by what it looks like
// (an expansion fitting, a pole-top transformer, a meter on a wire) instead of reading a label.
// The calculator hub uses them today; any screen can (materials, bending, safety, the wheel…).
//
// Every picture shares one style so a grid of them reads as a set:
//   - a 64 × 64 viewBox, drawn to sit inside a 4-unit margin;
//   - one stroke width (ART_STROKE) set on the <svg>, round caps and joins, no fill by default;
//   - currentColor for the drawing, so it follows the text colour in light and dark themes;
//   - one accent, the brand amber, through two classes styled in css/calcs.css (.ft-art):
//       class="a"  accent stroke   (var(--accent): dark amber on light, gold on dark)
//       class="af" accent fill     (var(--accent-fill)), outlined in currentColor unless stroke="none"
//     Without that stylesheet the accent falls back to currentColor, so nothing disappears.
//   - opacity=".5" marks secondary lines (light beams, a third phase, reference lines).
// No style attributes, handlers or text: the markup is static, CSP-safe and font-independent.
//
//   import { art } from '../lib/calc-art.js';
//   card.append(art('transformer', { size: 64 }));             // decorative (aria-hidden)
//   card.append(art('transformer', { label: 'Transformer' })); // stands alone: role="img"

export const ART_VIEWBOX = '0 0 64 64';
export const ART_STROKE = 2.5;

const NS = 'http://www.w3.org/2000/svg';
const dot = (cx, cy, r = 1.8, cls = '') => `<circle${cls ? ` class="${cls}"` : ''} cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const copper = (cx, cy, r = 2.5) => `<circle class="af" cx="${cx}" cy="${cy}" r="${r}" stroke="none"/>`;

/** A sine wave across x 8–56 (one period), phase in radians, as a smooth polyline. */
function wave(phase) {
  const pts = [];
  for (let x = 8; x <= 56; x += 2) {
    const y = 32 - 14 * Math.sin(((x - 8) / 48) * 2 * Math.PI - phase);
    pts.push(`${pts.length ? 'L' : 'M'}${x} ${Math.round(y * 10) / 10}`);
  }
  return pts.join('');
}

/**
 * id → { alt, svg }. `alt` says what is drawn (used as the accessible name when a picture stands
 * alone); `svg` is the child markup for a 64 × 64 viewBox.
 */
export const ART = {
  // Conductors & circuits
  vd: {
    alt: 'A meter on a wire with its needle falling',
    svg: '<rect x="8" y="6" width="48" height="36" rx="5"/>'
      + '<path d="M16 36a16 16 0 0 1 32 0"/>'
      + '<path d="M16 36h4M20.7 24.7l2.8 2.8M32 20v4M43.3 24.7l-2.8 2.8M48 36h-4"/>'
      + '<path class="a" d="M32 36L20.2 30.5"/>' + dot(32, 36, 2.2)
      + '<path class="a" d="M50 11v8M47 16l3 3 3-3"/>'
      + '<path d="M22 42v8M42 42v8"/>'
      + '<rect x="4" y="50" width="46" height="8" rx="4"/>'
      + '<path class="a" d="M50 54h10"/>',
  },
  wire: {
    alt: 'A stripped conductor and a smaller bond wire with a size mark',
    svg: '<rect x="4" y="12" width="28" height="20" rx="5"/>'
      + '<rect class="af" x="32" y="16" width="18" height="12" rx="2"/>'
      + '<path d="M36 22h10"/>'
      + '<path d="M54 16h6M54 28h6M57 16v12"/>'
      + '<rect x="4" y="40" width="28" height="12" rx="6"/>'
      + '<rect class="af" x="32" y="43" width="12" height="6" rx="1.5"/>',
  },
  ohms: {
    alt: 'A battery and a resistor in a circuit',
    svg: '<path d="M12 30V14h10M42 14h10v34H12V36"/>'
      + '<path class="a" d="M22 14l2.5-5 5 10 5-10 5 10 2.5-5"/>'
      + '<path d="M5 30h14M8.5 36h7"/>'
      + '<path class="a" d="M48 30l4 4 4-4"/>',
  },
  '3ph': {
    alt: 'Three sine waves a third of a cycle apart',
    svg: '<path opacity=".4" d="M6 32h52"/>'
      + `<path d="${wave(0)}"/>`
      + `<path class="a" d="${wave((2 * Math.PI) / 3)}"/>`
      + `<path opacity=".5" d="${wave((4 * Math.PI) / 3)}"/>`,
  },

  // Raceway & cable
  conduit: {
    alt: 'A conduit cut open, with conductors lying inside',
    svg: '<circle cx="32" cy="32" r="27"/><circle cx="32" cy="32" r="22.5"/>'
      + [[20, 38], [32, 43], [44, 38], [26, 27], [38, 27]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5"/>${copper(x, y)}`).join(''),
  },
  box: {
    alt: 'A device box with two wires joined in a wire nut',
    svg: '<rect x="10" y="14" width="44" height="44" rx="4"/>'
      + '<path d="M26 14v-3h12v3M26 58v3h12v-3"/>'
      + '<path d="M20 4v12c0 8 6 8 8 18M44 4v12c0 8-6 8-8 18"/>'
      + '<path class="af" d="M25 34h14l-3 13h-8z"/>'
      + '<circle cx="45" cy="50" r="3"/>',
  },
  expansion: {
    alt: 'A conduit expansion fitting: a barrel with a sliding inner pipe',
    svg: '<path d="M4 26h12M4 38h12"/>'
      + '<rect x="16" y="18" width="6" height="28" rx="1.5"/>'
      + '<path d="M22 21h18M22 43h18"/>'
      + '<rect x="40" y="18" width="6" height="28" rx="1.5"/>'
      + '<path d="M46 26h14M46 38h14"/>'
      + '<path opacity=".5" d="M28 26h12M28 38h12M28 26v12"/>'
      + '<path class="a" d="M24 10h16M28 6l-4 4 4 4M36 6l4 4-4 4"/>',
  },
  cablepull: {
    alt: 'Cable pulled off a reel through a conduit bend',
    svg: '<circle cx="16" cy="40" r="12"/><circle cx="16" cy="40" r="3.5"/>'
      + '<path d="M8 60l8-20 8 20M4 60h26"/>'
      + '<path d="M34 42h10a8 8 0 0 0 8-8V12M34 50h10a16 16 0 0 0 16-16V12M34 42v8M52 12h8"/>'
      + '<path class="a" d="M16 28c8 0 10 18 18 18h10a12 12 0 0 0 12-12V4M52 8l4-4 4 4"/>',
  },
  ductbank: {
    alt: 'A concrete duct bank in the ground with six ducts',
    svg: '<path d="M4 12h56"/>'
      + '<path d="M10 12l-2-5M14 12V6M50 12l2-5M46 12V6"/>'
      + '<rect x="8" y="22" width="48" height="34" rx="2"/>'
      + [[18, 32], [32, 32], [46, 32], [18, 46], [32, 46], [46, 46]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5"/>`).join('')
      + copper(18, 32) + copper(32, 32) + copper(46, 32) + copper(18, 46),
  },
  burial: {
    alt: 'A buried conduit with the depth of cover marked',
    svg: '<path d="M4 18h56"/>'
      + '<path d="M26 18l-2-6M30 18v-7M34 18l2-6M48 18l-2-6M52 18v-7M56 18l2-6"/>'
      + '<path class="a" d="M16 19v23M12 23l4-4 4 4M12 39l4 4 4-4"/>'
      + '<path opacity=".5" stroke-dasharray="3 4" d="M10 43h22"/>'
      + '<circle cx="40" cy="50" r="7"/>' + copper(40, 50, 3)
      + dot(30, 30, 1.3) + dot(50, 32, 1.3) + dot(8, 54, 1.3) + dot(24, 56, 1.3) + dot(56, 58, 1.3),
  },

  // Loads & motors
  load: {
    alt: 'A house with a service mast and meter',
    svg: '<path d="M4 30L24 12l20 18"/>'
      + '<path d="M8 27v27h32V27"/>'
      + '<path d="M20 54V42h8v12"/>'
      + '<path d="M52 9v25M47 10a5 5 0 0 1 10 0"/>'
      + '<rect x="46" y="34" width="12" height="16" rx="2"/>'
      + '<circle class="af" cx="52" cy="42" r="3.5"/>'
      + '<path d="M40 44h6M2 56h60"/>',
  },
  motor: {
    alt: 'An electric motor with cooling ribs, shaft and feet',
    svg: '<rect x="12" y="16" width="32" height="28" rx="4"/>'
      + '<path d="M17 23h22M17 30h22M17 37h22"/>'
      + '<rect x="5" y="20" width="7" height="20" rx="2"/>'
      + '<rect x="22" y="9" width="12" height="7" rx="1.5"/>'
      + '<rect class="af" x="44" y="27" width="13" height="6" rx="1.5"/>'
      + '<path d="M18 44l-3 7M38 44l3 7M10 52h40"/>',
  },
  transformer: {
    alt: 'A pole-top transformer with two bushings',
    svg: '<rect x="4" y="2" width="6" height="60" rx="1"/>'
      + '<path d="M10 28h8M10 46h8"/>'
      + '<path d="M18 22v28a16 4 0 0 0 32 0V22"/>'
      + '<ellipse cx="34" cy="22" rx="16" ry="4"/>'
      + '<rect x="22" y="7" width="6" height="11" rx="1"/><rect x="40" y="7" width="6" height="11" rx="1"/>'
      + '<path d="M20 11h10M38 11h10"/>'
      + '<path class="a" d="M25 7V2M43 7V2"/>'
      + '<path opacity=".5" d="M18 36a16 4 0 0 0 32 0"/>',
  },
  potlight: {
    alt: 'Two pot lights in a ceiling with the spacing between them',
    svg: '<path d="M4 16h56"/>'
      + '<rect x="11" y="6" width="14" height="10" rx="1"/><rect x="39" y="6" width="14" height="10" rx="1"/>'
      + '<path class="af" d="M12 16a6 4 0 0 0 12 0z"/><path class="af" d="M40 16a6 4 0 0 0 12 0z"/>'
      + '<path opacity=".5" d="M13 25l-5 17M23 25l5 17M41 25l-5 17M51 25l5 17"/>'
      + '<path d="M18 54h28M18 50v8M46 50v8"/>',
  },

  // Protection & testing
  ka: {
    alt: 'A two-pole circuit breaker beside a lightning bolt of fault current',
    svg: '<rect x="4" y="8" width="32" height="48" rx="4"/>'
      + '<circle cx="13" cy="15" r="2.5"/><circle cx="27" cy="15" r="2.5"/><circle cx="13" cy="49" r="2.5"/><circle cx="27" cy="49" r="2.5"/>'
      + '<rect x="9" y="24" width="22" height="16" rx="2"/>'
      + '<rect x="11.5" y="26.5" width="17" height="5" rx="1" fill="currentColor" stroke="none"/>'
      + '<path class="af" d="M51 6L41 32h8l-4 26 15-33h-9l6-19z"/>',
  },
  arcflash: {
    alt: 'An arc-flash hood with a tinted visor',
    svg: '<path d="M8 60c1-8 5-11 10-12V28a14 14 0 0 1 28 0v20c5 1 9 4 10 12z"/>'
      + '<rect class="af" x="21" y="24" width="22" height="14" rx="4"/>'
      + '<path class="a" d="M55 4l-5 8h7l-5 9"/>',
  },
  sccr: {
    alt: 'A control panel with devices on a rail and a rating nameplate',
    svg: '<rect x="10" y="6" width="44" height="52" rx="3"/>'
      + '<rect x="17" y="12" width="7" height="14" rx="1"/><rect x="28" y="12" width="7" height="14" rx="1"/><rect x="39" y="12" width="8" height="14" rx="1"/>'
      + '<path d="M15 30h34"/>'
      + '<rect class="af" x="18" y="39" width="28" height="13" rx="1.5"/>'
      + '<path d="M23 45.5h12"/>',
  },
  ground: {
    alt: 'A ground rod and two test stakes wired to an earth tester',
    svg: '<rect x="22" y="4" width="20" height="12" rx="2"/>'
      + '<rect class="af" x="26" y="7.5" width="12" height="5" rx="1" stroke="none"/>'
      + '<path d="M4 30h56"/>'
      + '<rect x="10" y="24" width="4" height="34" rx="1" fill="currentColor" stroke="none"/>'
      + '<path d="M36 24v14M54 24v14"/>'
      + '<path d="M25 16c0 5-13 3-13 8M32 16c0 5 4 4 4 8M39 16c0 5 15 3 15 8"/>',
  },

  // Solar, storage & backup
  solarpv: {
    alt: 'A solar panel on a stand under the sun',
    svg: '<circle class="af" cx="14" cy="13" r="5"/>'
      + '<path class="a" d="M22 13h3M19.7 7.3l2.1-2.1M14 5V2M8.3 7.3L6.2 5.2M6 13H3M8.3 18.7l-2.1 2.1M19.7 18.7l2.1 2.1"/>'
      + '<path d="M10 50l8-24h40l-8 24z"/>'
      + '<path d="M28 26l-8 24M38 26l-8 24M48 26l-8 24M14 38h40"/>'
      + '<path d="M30 50v8M20 58h20"/>',
  },
  ess: {
    alt: 'A battery with terminals and charge bars',
    svg: '<rect x="10" y="14" width="44" height="42" rx="4"/>'
      + '<rect x="18" y="8" width="8" height="6" rx="1"/><rect x="38" y="8" width="8" height="6" rx="1"/>'
      + '<path d="M19 24h6M22 21v6M39 24h6"/>'
      + '<rect class="af" x="16" y="34" width="8" height="16" rx="1"/>'
      + '<rect class="af" x="28" y="34" width="8" height="16" rx="1"/>'
      + '<rect x="40" y="34" width="8" height="16" rx="1"/>',
  },
  generator: {
    alt: 'A standby generator wired to a transfer switch',
    svg: '<rect x="4" y="20" width="36" height="30" rx="3"/>'
      + '<path d="M9 27h11M9 32h11M9 37h11M9 42h11"/>'
      + '<circle cx="31" cy="35" r="6"/>'
      + '<path d="M26.5 35q2.25-6 4.5 0t4.5 0"/>'
      + '<path d="M8 50v4M36 50v4M4 54h36"/>'
      + '<path d="M40 31h6"/>'
      + '<rect x="46" y="12" width="14" height="26" rx="2"/>'
      + dot(50, 18) + dot(56, 18) + dot(53, 32)
      + '<path class="a" d="M53 32L50 19"/>',
  },
};

/** True when a picture exists for `id`. */
export const hasArt = (id) => Object.prototype.hasOwnProperty.call(ART, id);

/** The whole <svg> as a string (print, server-rendered pages, tests). Unknown ids give ''. */
export function artMarkup(id, { size = 64 } = {}) {
  if (!hasArt(id)) return '';
  return `<svg xmlns="${NS}" class="ft-art" viewBox="${ART_VIEWBOX}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${ART_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[id].svg}</svg>`;
}

/**
 * art('expansion', { size, label, className }) -> <svg>. Decorative (aria-hidden) unless `label`
 * is given, then role="img" with that name (pass true to use the picture's own description).
 * Unknown ids render an empty frame of the same size so layouts never jump.
 */
export function art(id, { size = 64, label, className } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ft-art ${className}` : 'ft-art');
  svg.setAttribute('viewBox', ART_VIEWBOX);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(ART_STROKE));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label && hasArt(id)) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label === true ? ART[id].alt : String(label));
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = hasArt(id) ? ART[id].svg : '';
  return svg;
}
