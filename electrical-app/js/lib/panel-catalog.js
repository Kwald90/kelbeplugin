// Panel catalogue: manufacturer -> line -> size data for the panel picker (S26). Pure data and
// helpers, no DOM, offline. The breaker-family facts (width class, CTL/tandem acceptance, quad
// form) are well sourced; the per-size amp/space/bus rows are typical-catalogue VERIFY values, not
// an exhaustive price book. Canada-grounded (canadabreakers.ca and the makers' CA catalogues).
//
// Each entry: {
//   manufacturer, line, family (generator key, see breaker-partnumbers.js), breakerFamily (human),
//   breakerWidth '1in'|'3/4in'|'1/2in', sizes:[{amps, spaces, mainType 'MB'|'MLO', busAmps}],
//   tandems 'all'|'marked'|'none', tandemNote, quad:boolean, region, verify:[...], safetyFlag? }
//
// tandems: 'all' = half-space tandems accepted in any space; 'marked' = CTL, only in the spaces the
// label marks (fill from the end opposite the main); 'none' = no tandems. Plug-on-neutral panels
// reject CTL tandems — note per line. quad: two full spaces can carry up to four circuits (outer
// 1-pole singles plus an inner handle-tied 2-pole), ties into the panel grid's quad model.

/** The catalogue. Order is the picker order (defaults and common lines first). */
export const PANEL_MANUFACTURERS = [
  {
    manufacturer: 'Square D', line: 'Homeline', family: 'HOM', breakerFamily: 'Square D Homeline (HOM)',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 125, spaces: 24, mainType: 'MB', busAmps: 125 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 200, spaces: 42, mainType: 'MLO', busAmps: 200 },
    ],
    tandems: 'all', tandemNote: 'Homeline takes half-space tandems (HOMT) broadly; plug-on-neutral kits still reject CTL tandems in marked-only spaces. VERIFY the can label.',
    quad: true, region: 'CA US',
    verify: ['Sizes are typical catalogue values — VERIFY against the can label.', 'Plug-on only (no bolt-on).'],
  },
  {
    manufacturer: 'Square D', line: 'QO', family: 'QO', breakerFamily: 'Square D QO (QOB bolt-on)',
    breakerWidth: '3/4in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 125, spaces: 30, mainType: 'MB', busAmps: 125 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 225, spaces: 42, mainType: 'MLO', busAmps: 225 },
    ],
    tandems: 'marked', tandemNote: 'QO is CTL: tandems (QO tandem) only in the spaces the label marks, filled from the end opposite the main.',
    quad: true, region: 'CA US',
    verify: ['QO is the 3/4" narrow frame — do not mix with 1" Homeline.', 'Quad SKU form VERIFY.'],
  },
  {
    manufacturer: 'Eaton', line: 'BR', family: 'BR', breakerFamily: 'Eaton BR',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 125, spaces: 30, mainType: 'MB', busAmps: 125 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 200, spaces: 40, mainType: 'MLO', busAmps: 200 },
    ],
    tandems: 'all', tandemNote: 'BR takes tandems (BD, one space) broadly; CTL loadcentres mark the allowed spaces. BR{AABB} is the pre-1968 legacy form.',
    quad: true, region: 'CA US',
    verify: ['Sizes are typical catalogue values — VERIFY.', 'BR quad = two independent 2-pole (BRD).'],
  },
  {
    manufacturer: 'Eaton', line: 'CH', family: 'CH', breakerFamily: 'Eaton CH (CHF fault family)',
    breakerWidth: '3/4in',
    sizes: [
      { amps: 100, spaces: 20, mainType: 'MB', busAmps: 100 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 200, spaces: 30, mainType: 'MLO', busAmps: 200 },
    ],
    tandems: 'marked', tandemNote: 'CH is CTL: tandems (CHT) only in the marked spaces.',
    quad: true, region: 'CA US',
    verify: ['CH is the premium 3/4" frame — do not mix with 1" BR.', 'Sizes VERIFY.'],
  },
  {
    manufacturer: 'Siemens', line: 'QP', family: 'Q', breakerFamily: 'Siemens type QP (Q)',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 125, spaces: 30, mainType: 'MB', busAmps: 125 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 200, spaces: 42, mainType: 'MLO', busAmps: 200 },
    ],
    tandems: 'marked', tandemNote: 'Siemens is CTL: type QT tandems only in the marked spaces (non-CTL QT on plug-on-neutral). Interchanges with Murray/ITE.',
    quad: true, region: 'CA US',
    verify: ['Canadian breakers append CSA to the type (e.g. Q120DFCSA).', 'Quad SKU form VERIFY.'],
  },
  {
    manufacturer: 'GE/ABB', line: 'Q-Line', family: 'THQL', breakerFamily: 'GE/ABB Q-Line (THQL 1", THQP 1/2")',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
      { amps: 200, spaces: 32, mainType: 'MLO', busAmps: 200 },
    ],
    tandems: 'marked', tandemNote: 'Q-Line is CTL: THQL tandems (THQLT) only in marked spaces. THQP is the 1/2" half-width breaker (two per 1" space) — no combined tandem body. Now ABB ReliaHome.',
    quad: false, region: 'CA US',
    verify: ['THQP half-width breakers are 1/2" — a size-class apart from THQL.', 'Sizes VERIFY.'],
  },
  {
    manufacturer: 'Federal Pioneer', line: 'Stab-lok', family: null, breakerFamily: 'Federal Pioneer Stab-lok (NA, proprietary)',
    breakerWidth: '1in',
    sizes: [
      { amps: 60, spaces: 12, mainType: 'MB', busAmps: 60 },
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
    ],
    tandems: 'none', tandemNote: 'Vintage proprietary panel — do not design new circuits into it.',
    quad: false, region: 'CA', safetyFlag: 'Federal Pioneer Stab-lok has a documented history of breakers failing to trip. Assess and recommend replacement; do not treat as a target for new work.',
    verify: ['Stab-lok is proprietary — only Stab-lok-listed breakers fit.', 'Vintage: assess/replace.'],
  },
  {
    manufacturer: 'Murray', line: 'Murray', family: 'Q', breakerFamily: 'Murray (MP, Siemens-compatible)',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 24, mainType: 'MB', busAmps: 100 },
      { amps: 200, spaces: 40, mainType: 'MB', busAmps: 200 },
    ],
    tandems: 'marked', tandemNote: 'Legacy line folded into Siemens; Murray MP interchanges with Siemens type QP. CTL, marked spaces only.',
    quad: false, region: 'CA US',
    verify: ['Discontinued brand — source Siemens-equivalent breakers.', 'Sizes VERIFY.'],
  },
  {
    manufacturer: 'Leviton', line: 'Leviton', family: null, breakerFamily: 'Leviton (proprietary plug-on)',
    breakerWidth: '1in',
    sizes: [
      { amps: 100, spaces: 20, mainType: 'MB', busAmps: 100 },
      { amps: 200, spaces: 42, mainType: 'MB', busAmps: 200 },
    ],
    tandems: 'none', tandemNote: 'Proprietary smart-panel line; use Leviton-branded breakers only.',
    quad: false, region: 'CA US',
    verify: ['Proprietary — only Leviton breakers fit.', 'Sizes VERIFY.'],
  },
];

/** The default pick for a new build: Square D Homeline, 200 A, 40-space main breaker. */
export const DEFAULT = Object.freeze({
  manufacturer: 'Square D', line: 'Homeline', amps: 200, spaces: 40, mainType: 'MB', busAmps: 200,
});

/** Unique manufacturer names, in catalogue order. */
export function manufacturers() {
  const seen = new Set();
  const out = [];
  for (const e of PANEL_MANUFACTURERS) {
    if (seen.has(e.manufacturer)) continue;
    seen.add(e.manufacturer);
    out.push(e.manufacturer);
  }
  return out;
}

/** The line names offered for a manufacturer, in catalogue order. */
export function linesFor(manufacturer) {
  return PANEL_MANUFACTURERS.filter((e) => e.manufacturer === manufacturer).map((e) => e.line);
}

/** The catalogue entry for a manufacturer + line, or null. */
export function catalogEntry(manufacturer, line) {
  return PANEL_MANUFACTURERS.find((e) => e.manufacturer === manufacturer && e.line === line) || null;
}

/** The size rows for a manufacturer + line (a fresh array), or [] if unknown. */
export function sizesFor(manufacturer, line) {
  const e = catalogEntry(manufacturer, line);
  return e ? e.sizes.map((s) => ({ ...s })) : [];
}
