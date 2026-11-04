// Labour levels: crew classifications that each carry a cost rate, a charge (bill) rate and a
// PRODUCTIVITY factor. The same work takes a 1st-year apprentice longer than a journeyman, and
// costs a different amount, so an assembly's labour time and cost flex by who does it.
//
// Pure logic, shared by the settings screen, the assemblies screen and the apprentice-hours
// tracker. Levels live in company settings (store.settings().labourLevels); assembly `labourHours`
// is the JOURNEYMAN baseline (productivity 100%). Money is integer cents (CAD), hours are decimal.

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `lvl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n) => Math.round(Number(n) || 0);
const pct = (n) => Math.max(1, Math.min(400, Math.round(Number(n) || 0)));

/** Kinds of level, for the apprentice:journeyman ratio and grouping. */
export const LEVEL_KINDS = ['apprentice', 'journeyman', 'foreman', 'other'];

/**
 * Starting roster (Manitoba-style: three apprentice years + journeyman + foreman). Every value is
 * editable in settings; productivity is relative to a journeyman at 100%. Rates are placeholders.
 * Each has a STABLE id so that a level you assign to a person keeps matching across reads and
 * reloads, even before anyone edits the Levels tab (an id minted fresh each call would orphan the
 * assignment the instant the list is re-read).
 */
export const DEFAULT_LEVELS = [
  { id: 'lvl-appr-1', kind: 'apprentice', year: 1, name: 'Apprentice — 1st year', productivityPct: 55, costCents: 2200, chargeCents: 6500 },
  { id: 'lvl-appr-2', kind: 'apprentice', year: 2, name: 'Apprentice — 2nd year', productivityPct: 68, costCents: 2600, chargeCents: 7200 },
  { id: 'lvl-appr-3', kind: 'apprentice', year: 3, name: 'Apprentice — 3rd year', productivityPct: 82, costCents: 3000, chargeCents: 8000 },
  { id: 'lvl-journeyman', kind: 'journeyman', year: null, name: 'Journeyman', productivityPct: 100, costCents: 4200, chargeCents: 9500 },
  { id: 'lvl-foreman', kind: 'foreman', year: null, name: 'Foreman', productivityPct: 105, costCents: 5000, chargeCents: 11000 },
];

/** A fresh level record (defaults to a new journeyman-speed line). */
export function newLevel(patch = {}) {
  return {
    id: newId(),
    name: 'New level',
    kind: 'other',
    year: null,
    productivityPct: 100,
    costCents: 0,
    chargeCents: 0,
    archived: false,
    ...patch,
  };
}

/** Normalise a raw levels array from settings: fill ids, clamp numbers, drop blanks. Always returns an array. */
export function normalizeLevels(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({
      id: l.id || newId(),
      name: String(l.name || '').slice(0, 80) || 'Level',
      kind: LEVEL_KINDS.includes(l.kind) ? l.kind : 'other',
      year: [1, 2, 3, 4].includes(Number(l.year)) ? Number(l.year) : null,
      productivityPct: pct(l.productivityPct ?? 100),
      costCents: cents(l.costCents),
      chargeCents: cents(l.chargeCents),
      archived: !!l.archived,
    }));
}

/** The levels to show (seed the defaults when none are set yet). */
export function levelsOf(settings) {
  const list = normalizeLevels(settings?.labourLevels);
  return list.length ? list : normalizeLevels(DEFAULT_LEVELS);
}

/** Levels a user actually picks from (not archived). */
export const activeLevels = (settings) => levelsOf(settings).filter((l) => !l.archived);

/** Find a level by id, or null. */
export const levelById = (settings, id) => levelsOf(settings).find((l) => l.id === id) || null;

/**
 * The baseline level that an assembly's stored hours are quoted at (productivity 100%). Settings
 * may name one (baselineLevelId); otherwise the first journeyman, else the 100% one, else the first.
 */
export function baselineLevel(settings) {
  const list = levelsOf(settings);
  if (!list.length) return null;
  const named = settings?.baselineLevelId && list.find((l) => l.id === settings.baselineLevelId);
  return named
    || list.find((l) => l.kind === 'journeyman')
    || list.find((l) => l.productivityPct === 100)
    || list[0];
}

/**
 * Effective labour hours for `baseHours` of work (quoted at the baseline) when `level` does it.
 * Lower productivity -> more hours. e.g. 1.0 h at 55% productivity -> ~1.82 h.
 */
export function effectiveHours(baseHours, level, settings) {
  const base = Math.max(0, Number(baseHours) || 0);
  const basePct = baselineLevel(settings)?.productivityPct || 100;
  const lvlPct = level?.productivityPct || 100;
  return round2(base * (basePct / lvlPct));
}

/** Labour COST (what the crew costs you) for `baseHours` done by `level`. */
export function levelCostCents(baseHours, level, settings) {
  return cents(effectiveHours(baseHours, level, settings) * (level?.costCents || 0));
}

/** Labour CHARGE (what you bill) for `baseHours` done by `level`. */
export function levelChargeCents(baseHours, level, settings) {
  return cents(effectiveHours(baseHours, level, settings) * (level?.chargeCents || 0));
}

/**
 * Per-level breakdown of one assembly's labour: effective hours, cost, charge and the margin, for
 * every active level — the "who does it changes the time and the money" table.
 * @returns {{ level, hours, costCents, chargeCents, marginCents }[]}
 */
export function labourByLevel(baseHours, settings) {
  return activeLevels(settings).map((level) => {
    const hours = effectiveHours(baseHours, level, settings);
    const costCents = cents(hours * level.costCents);
    const chargeCents = cents(hours * level.chargeCents);
    return { level, hours, costCents, chargeCents, marginCents: chargeCents - costCents };
  });
}

/**
 * Blend a crew mix across a job: shares that sum to ~1 (normalised if not). Returns blended
 * effective hours and money for `baseHours`, plus the parts.
 * @param {{ levelId: string, share: number }[]} mix
 */
export function crewMix(baseHours, mix, settings) {
  const parts = (Array.isArray(mix) ? mix : [])
    .map((m) => ({ level: levelById(settings, m.levelId), share: Math.max(0, Number(m.share) || 0) }))
    .filter((p) => p.level && p.share > 0);
  const total = parts.reduce((s, p) => s + p.share, 0);
  if (!total) {
    const bl = baselineLevel(settings);
    return { hours: round2(baseHours), costCents: levelCostCents(baseHours, bl, settings), chargeCents: levelChargeCents(baseHours, bl, settings), parts: [] };
  }
  let hours = 0; let costCents = 0; let chargeCents = 0; const out = [];
  for (const p of parts) {
    const frac = p.share / total;
    const h = effectiveHours(baseHours * frac, p.level, settings);
    const c = cents(h * p.level.costCents);
    const ch = cents(h * p.level.chargeCents);
    hours += h; costCents += c; chargeCents += ch;
    out.push({ level: p.level, share: round2(frac), hours: round2(h), costCents: c, chargeCents: ch });
  }
  return { hours: round2(hours), costCents, chargeCents, parts: out };
}

// ---- apprentice-hours tracker ---------------------------------------------------------------

const hoursOf = (entry) => {
  if (Number.isFinite(entry?.hours)) return Math.max(0, entry.hours);
  if (Number.isFinite(entry?.minutes)) return Math.max(0, entry.minutes) / 60;
  return 0;
};

/**
 * Roll time entries up by labour level. Each entry needs an employeeId; `employeeLevel` maps an
 * employee id to a level id (employee.labourLevelId). Entries whose employee has no level, or an
 * unknown one, fall into an "Unassigned" bucket so hours are never lost.
 * @returns {{ rows: {level, hours, costCents}[], totalHours, byKind: Record<string,number>, apprenticeHours, journeymanHours, ratio }}
 */
export function apprenticeHours(entries, { employeeLevel = {}, settings } = {}) {
  const levels = levelsOf(settings);
  const byId = new Map(levels.map((l) => [l.id, { level: l, hours: 0, costCents: 0 }]));
  const unassigned = { level: null, hours: 0, costCents: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    const h = hoursOf(e);
    if (!h) continue;
    const lvlId = employeeLevel[e.employeeId];
    const slot = (lvlId && byId.get(lvlId)) || unassigned;
    slot.hours += h;
    if (slot.level) slot.costCents += cents(h * slot.level.costCents);
  }
  const rows = [...byId.values()].filter((r) => r.hours > 0).map((r) => ({ ...r, hours: round2(r.hours) }));
  if (unassigned.hours > 0) rows.push({ ...unassigned, hours: round2(unassigned.hours) });
  const byKind = {};
  for (const r of rows) { const k = r.level?.kind || 'unassigned'; byKind[k] = round2((byKind[k] || 0) + r.hours); }
  const apprenticeH = byKind.apprentice || 0;
  const journeymanH = (byKind.journeyman || 0) + (byKind.foreman || 0);
  const totalHours = round2(rows.reduce((s, r) => s + r.hours, 0));
  return {
    rows,
    totalHours,
    byKind,
    apprenticeHours: round2(apprenticeH),
    journeymanHours: round2(journeymanH),
    // Apprentice hours per journeyman hour (a 1:1 shop reads 1.0). null when no journeyman hours yet.
    ratio: journeymanH > 0 ? round2(apprenticeH / journeymanH) : null,
  };
}
