// Recessed ("pot") light layout: how many lights, how far apart, and where.
// Pure and DOM-free, so the Calculators tab and the canvas room layout share it.
//
// Two ideas combine:
//   geometry   — spacing ≈ ceiling height ÷ 2 (a long-standing rule of thumb)
//                sets an even grid with a half-spacing border off the walls;
//   brightness — a target light level for the room (footcandles) and the
//                fixture's lumens set how many lights the room actually needs.
// The recommended count is whichever of the two is greater, laid out as an even
// grid. A manual count overrides both and the spacing re-solves to stay even,
// which is the "add one more and it recalculates" behaviour.
//
// Units: lengths in metres, areas in m², light in lumens and footcandles
// (1 fc = 1 lumen per ft²). This is an estimating aid, not a photometric design.

export const M_PER_FT = 0.3048;
const FT2_PER_M2 = 1 / (M_PER_FT * M_PER_FT); // 10.7639 ft² per m²

/** Common residential LED pot lights, by nominal aperture. */
export const FIXTURES = [
  { id: '3in', label: '3" LED', lumens: 500 },
  { id: '4in', label: '4" LED', lumens: 650 },
  { id: '6in', label: '5"/6" LED', lumens: 900 },
  { id: '6in-ho', label: '6" high-output', lumens: 1100 },
];
export const DEFAULT_LUMENS = 650;

// Target maintained light level in footcandles, by room type. Residential
// values informed by IES ranges; keys match ROOM_TYPES in placement-rules.js.
export const TARGET_FC = {
  kitchen: 40, bathroom: 30, living: 20, dining: 30, bedroom: 15,
  hallway: 10, laundry: 30, garage: 30, basement: 20, outdoor: 10, other: 20,
  workarea: 50, // shop / work area — a starting point; dial it in per space
};
export const DEFAULT_TARGET_FC = 20;

// Not all of a lamp's rated lumens reach the work plane from a recessed can:
// trim, aiming and room-surface losses. One honest factor stands in for the
// coefficient of utilization and light-loss factor a full design would use.
export const DEFAULT_EFFICIENCY = 0.7;

// Rule-of-thumb spacing bounds (metres) so a very low ceiling can't produce
// silly spacing. The upper bound is generous so tall commercial ceilings
// (shops, warehouses) space their high-bays wider, as they should.
export const MIN_SPACING_M = 0.9;
export const MAX_SPACING_M = 4.5;
const DEFAULT_CEILING_M = 2.44; // 8 ft

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pos = (x, fallback = 0) => (Number(x) > 0 ? Number(x) : fallback);

/** Rule-of-thumb spacing between lights for a ceiling height (metres). */
export function spacingForCeiling(ceilingM) {
  return clamp(pos(ceilingM, DEFAULT_CEILING_M) / 2, MIN_SPACING_M, MAX_SPACING_M);
}

/** Lumens a room needs for a target light level. area m², target footcandles. */
export function requiredLumens(areaM2, targetFc, efficiency = DEFAULT_EFFICIENCY) {
  const ft2 = pos(areaM2) * FT2_PER_M2;
  const fc = Math.max(0, Number(targetFc) || 0);
  return (ft2 * fc) / pos(efficiency, DEFAULT_EFFICIENCY);
}

/** Footcandles delivered by `count` fixtures of `lumens` each over area m². */
export function footcandles(count, lumens, areaM2, efficiency = DEFAULT_EFFICIENCY) {
  const ft2 = pos(areaM2) * FT2_PER_M2;
  if (!(ft2 > 0)) return 0;
  return (Math.max(0, count) * Math.max(0, Number(lumens) || 0) * pos(efficiency, DEFAULT_EFFICIENCY)) / ft2;
}

/**
 * Lay `count` lights in a tidy grid inside an L×W room. Columns run along the
 * length, rows along the width, chosen so the grid's aspect roughly matches the
 * room's. Points come back as { u, v } fractions of length and width (0..1),
 * each with a half-spacing border off the walls. A short last row is centred.
 */
export function gridFor(count, lengthM, widthM) {
  const N = Math.max(0, Math.round(Number(count) || 0));
  if (N === 0) return { cols: 0, rows: 0, count: 0, points: [], spacingLenM: 0, spacingWidM: 0 };
  const L = pos(lengthM, 1), W = pos(widthM, 1);
  let cols = clamp(Math.round(Math.sqrt(N * (L / W))), 1, N);
  let rows = Math.ceil(N / cols);
  // trim columns the grid doesn't need (e.g. 3 cols for 4 lights → use 2)
  while (cols > 1 && (cols - 1) * rows >= N) cols -= 1;
  rows = Math.ceil(N / cols);
  const points = [];
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, N - r * cols); // lights in this row
    const c = i % cols;
    const u = (c + 0.5 + (cols - inRow) / 2) / cols; // centre a short last row
    const v = (r + 0.5) / rows;
    points.push({ u, v });
  }
  return { cols, rows, count: N, points, spacingLenM: L / cols, spacingWidM: W / rows };
}

/**
 * Recommend a pot light layout for a room.
 *   lengthM, widthM  room size, the two run directions (metres)
 *   ceilingM         ceiling height for the spacing rule (metres)
 *   targetFc         desired light level, footcandles (0 to skip brightness)
 *   lumens           per-fixture lumens
 *   efficiency       usable-light factor
 *   count            if > 0, lay out exactly this many (manual override)
 * Returns the chosen grid plus the drivers behind it:
 *   { count, cols, rows, points, spacingLenM, spacingWidM, spacingM, areaM2,
 *     geomCount, brightCount, targetFc, fc, lumens, requiredLm, efficiency, driver }
 * driver is 'manual' | 'brightness' | 'spacing' — what set the count.
 */
export function solveLayout({
  lengthM, widthM, ceilingM, targetFc = 0, lumens = DEFAULT_LUMENS,
  efficiency = DEFAULT_EFFICIENCY, count = 0,
} = {}) {
  const L = pos(lengthM), W = pos(widthM);
  const areaM2 = L * W;
  const spacing = spacingForCeiling(ceilingM);
  const cols = Math.max(1, Math.round(L / spacing));
  const rows = Math.max(1, Math.round(W / spacing));
  const geomCount = areaM2 > 0 ? cols * rows : 0;
  const lm = pos(lumens, DEFAULT_LUMENS);
  const fc = Math.max(0, Number(targetFc) || 0);
  const reqLm = fc > 0 ? requiredLumens(areaM2, fc, efficiency) : 0;
  const brightCount = reqLm > 0 ? Math.ceil(reqLm / lm) : 0;

  let useCount, driver;
  if (Number(count) > 0) {
    useCount = Math.round(Number(count));
    driver = 'manual';
  } else if (areaM2 > 0) {
    useCount = Math.max(geomCount, brightCount, 1);
    driver = brightCount > geomCount ? 'brightness' : 'spacing';
  } else {
    useCount = 0;
    driver = 'spacing';
  }

  const grid = gridFor(useCount, L, W);
  return {
    ...grid, spacingM: spacing, areaM2, geomCount, brightCount,
    targetFc: fc, fc: footcandles(grid.count, lm, areaM2, efficiency),
    lumens: lm, requiredLm: reqLm, efficiency: pos(efficiency, DEFAULT_EFFICIENCY), driver,
  };
}
