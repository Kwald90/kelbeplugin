// Line art for the bend picker: the shape of the bent pipe for each kind of bend, so a bend can be
// found by its picture instead of by reading. Every drawing shares one 64 × 40 view box, one pipe
// stroke and the same floor line, and draws in currentColor (styles in css/bending.css), so it
// follows the button's text colour in the light and dark themes. No inline styles (CSP).

const FLOOR = '<path class="ba-surface" d="M2 34H62"/>';
const pipe = (d, cls = '') => `<path class="ba-pipe${cls ? ` ${cls}` : ''}" d="${d}"/>`;

/** Inner SVG markup per bend kind (the ids in js/lib/bending.js KINDS, plus 'pull'). */
export const BEND_ART = {
  // two equal bends up and over a step
  offset: FLOOR + '<rect class="ba-obst" x="41" y="17.5" width="21" height="16.5"/>'
    + pipe('M4 31H19Q22 31 24.1 28.9L35.9 17.1Q38 15 41 15H60'),
  // one bend: the end of the pipe kicks up off the floor
  kick: FLOOR + pipe('M4 31H30Q33.5 31 36.2 28.7L58 9'),
  // centre bend over a pipe, a side bend each side
  saddle3: FLOOR + '<circle class="ba-obst" cx="32" cy="27.5" r="6.5"/>'
    + pipe('M4 31H14Q16 31 17.6 29.6L29.4 19.6Q32 17.4 34.6 19.6L46.4 29.6Q48 31 50 31H60'),
  // up, across a block, and back down
  saddle4: FLOOR + '<rect class="ba-obst" x="20" y="21.5" width="24" height="12.5"/>'
    + pipe('M4 31H10Q12.5 31 13.9 28.9L19.1 21.1Q20.5 19 23 19H41Q43.5 19 44.9 21.1L50.1 28.9Q51.5 31 54 31H60'),
  // a stub-up: one 90 off the floor
  stub90: FLOOR + pipe('M12 4V22Q12 31 21 31H60'),
  // two 90s, a U
  backToBack: FLOOR + pipe('M10 4V22Q10 31 19 31H45Q54 31 54 22V4'),
  // a small offset into a box knockout
  boxOffset: FLOOR + '<rect class="ba-box" x="47" y="9" width="14" height="25" rx="1.5"/>'
    + pipe('M4 31H21Q23.5 31 25.3 29.2L28.7 25.8Q30.5 24 33 24H53'),
  // an offset that also rolls over: the bend, its shadow on the floor, and the roll
  rolling: FLOOR + '<path class="ba-ghost" d="M4 31H18L33 26H60"/>'
    + pipe('M4 31H18Q21 31 23.1 28.9L31.9 20.1Q34 18 37 18H60')
    + '<path class="ba-arrow" d="M45.8 7A4.2 4.2 0 1 1 49.3 11.1M49.3 11.1L52.4 9.7M49.3 11.1L51.7 13.6"/>',
  // three conduits offsetting together, each one further out bending a little later
  parallel: FLOOR
    + pipe('M4 31H23Q25 31 26.4 29.6L35.6 20.4Q37 19 39 19H60', 'ba-thin')
    + pipe('M4 24.5H20Q22 24.5 23.4 23.1L32.6 13.9Q34 12.5 36 12.5H60', 'ba-thin')
    + pipe('M4 18H17Q19 18 20.4 16.6L29.6 7.4Q31 6 33 6H60', 'ba-thin'),
  // a big sweep made of short straight shots
  segment: FLOOR + pipe('M8 4V12.5L9.3 18L12 22.9L16 26.9L20.9 29.6L26.5 31H60', 'ba-facet'),
  // a rack of 90s around one centre
  concentric: FLOOR
    + pipe('M19 3V12A8 8 0 0 0 27 20H60', 'ba-thin')
    + pipe('M13 3V12A14 14 0 0 0 27 26H60', 'ba-thin')
    + pipe('M7 3V12A20 20 0 0 0 27 32H60', 'ba-thin'),
  // add up the degrees: a dial three-quarters round
  pull: '<circle class="ba-surface" cx="32" cy="21" r="14"/>'
    + pipe('M18 21A14 14 0 1 1 32 35')
    + '<path class="ba-arrow" d="M32 35L36.5 31.2M32 35L36.5 38.6"/>',
};

/** The picture for a bend kind as an <svg> string (decorative: the button carries the name). */
export function bendArt(id) {
  return `<svg class="bend-art" viewBox="0 0 64 40" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${BEND_ART[id] || ''}</svg>`;
}
