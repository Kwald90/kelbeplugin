// Wire runs: totals, allowances, roll suggestions, estimate lines, CSV and the
// PDF report. Pure functions over a `wireRuns` record (docs/BUILD-PLAN.md), so
// they run in Node tests. Every length is in metres; the screen formats it with
// js/lib/units.js in the user's units.
import { fmtLength, M_PER_FT } from './units.js';
import { createPdf, createFlow, PDF_COLORS } from './pdf.js';

// ---------- code values and trade defaults ----------
/**
 * Free conductor at boxes. CSA C22.1 (CEC) Rule 12-3000(6): leave at least 150 mm of
 * free conductor at each outlet for joints or connecting equipment.
 * VERIFY: the rule number and value were confirmed for an earlier edition only;
 * check them against C22.1:24 (26th edition) and any provincial amendment.
 */
export const CEC_FREE_CONDUCTOR_M = 0.15;
export const CEC_FREE_CONDUCTOR_REF = 'CEC Rule 12-3000(6)';
/** A run that passes through a box has two cable ends in it, each needing the free length above. */
export const DEFAULT_BOX_MAKEUP_M = 2 * CEC_FREE_CONDUCTOR_M;
/** Cable entry to the breaker and neutral bar. Shop rule of thumb (about 3 ft), not a code value. */
export const DEFAULT_PANEL_MAKEUP_M = 0.9;
export const DEFAULT_WASTE_PCT = 10;
/**
 * NMD90 coil lengths sold in Canada. 75 m and 150 m coils are stock items for 14 to 10 AWG
 * (supplier listings: BMR, Franklin Empire, E.B. Horsman, Canadian Tire, 2026);
 * 300 m is listed for some sizes only. VERIFY with your supplier.
 */
export const ROLL_SIZES_M = [75, 150, 300];
/** Conduit stick length when the price-book item doesn't say: 3.05 m (10 ft). VERIFY per product. */
export const STICK_M = 3.05;
/** Typical AR tape error used for the on-screen caution (ARKit/ARCore, good conditions). VERIFY on your devices. */
export const AR_TYPICAL_ERROR_PCT = 2;

export const METHODS = [{ id: 'cable', label: 'Cable' }, { id: 'conduit', label: 'Conduit' }];
export const SOURCES = { ar: 'AR', plan: 'Plan', manual: 'Typed' };

export const CONDUIT_TYPES = [
  { id: 'EMT', label: 'EMT' },
  { id: 'RMC', label: 'Rigid steel (RMC)' },
  { id: 'IMC', label: 'IMC' },
  { id: 'AL', label: 'Rigid aluminum' },
  { id: 'PVC', label: 'Rigid PVC' },
  { id: 'ENT', label: 'ENT' },
  { id: 'FMC', label: 'Flex (FMC)' },
  { id: 'LFMC', label: 'Liquid-tight flex' },
];

/** Metric designators (CSA) with the trade size they replace. */
export const TRADE_SIZES = [
  ['16', '1/2'], ['21', '3/4'], ['27', '1'], ['35', '1 1/4'], ['41', '1 1/2'],
  ['53', '2'], ['63', '2 1/2'], ['78', '3'], ['91', '3 1/2'], ['103', '4'],
].map(([id, inch]) => ({ id, inch, label: `${id} (${inch}")` }));

export const CABLE_TYPES = ['NMD90', 'AC90', 'ACWU90', 'TECK90', 'NMWU'];
export const WIRE_TYPES = ['T90 Nylon', 'RW90', 'RWU90', 'TWU75', 'Bare'];
export const CABLE_SIZES = ['14/2', '14/3', '12/2', '12/3', '10/2', '10/3', '8/2', '8/3', '6/2', '6/3'];
export const WIRE_SIZES = ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '350', '500'];

// ---------- helpers ----------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pos = (v) => Math.max(0, num(v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const ceilTo = (x, d = 0) => { const k = 10 ** d; return Math.ceil(x * k - 1e-9) / k; };

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- records ----------
export function defaultAllowances() {
  return { drops: [], boxCount: 0, boxMakeupM: DEFAULT_BOX_MAKEUP_M, panelMakeupM: DEFAULT_PANEL_MAKEUP_M, wastePct: DEFAULT_WASTE_PCT };
}

export function newConductor(method = 'cable', fields = {}) {
  const base = method === 'conduit'
    ? { description: 'T90 Nylon 12 AWG', size: '12', material: 'cu', type: 'T90 Nylon', count: 3 }
    : { description: 'NMD90 14/2', size: '14/2', material: 'cu', type: 'NMD90', count: 1 };
  return { id: newId(), ...base, itemId: null, ...fields };
}

export function newSegment(fields = {}) {
  return { id: newId(), label: '', lengthM: 0, source: 'manual', note: '', ...fields };
}

/** Fields for store.add('wireRuns', ...). */
export function newRun({ name = 'New run', jobId = null, method = 'cable' } = {}) {
  return {
    name, jobId: jobId || null, drawingId: null, location: '',
    wiringMethod: method, conduit: method === 'conduit' ? { type: 'EMT', tradeSize: '21' } : null,
    segments: [], allowances: defaultAllowances(), conductors: [newConductor(method)],
    photos: [], notes: '', totalM: 0,
  };
}

/** Fill in anything missing so screens and maths can trust the shape. Returns a new object. */
export function normalizeRun(run = {}) {
  const a = run.allowances || {};
  const d = defaultAllowances();
  const method = run.wiringMethod === 'conduit' ? 'conduit' : 'cable';
  return {
    ...run,
    name: run.name ?? '',
    jobId: run.jobId || null,
    drawingId: run.drawingId || null,
    location: run.location ?? '',
    wiringMethod: method,
    conduit: method === 'conduit' ? { type: run.conduit?.type || 'EMT', tradeSize: run.conduit?.tradeSize || '21' } : (run.conduit || null),
    segments: (run.segments || []).map((s) => ({ id: s.id || newId(), label: s.label ?? '', lengthM: pos(s.lengthM), source: SOURCES[s.source] ? s.source : 'manual', note: s.note ?? '', ...(s.points ? { points: s.points } : {}) })),
    allowances: {
      drops: (a.drops || []).map((x) => ({ label: x.label ?? '', count: pos(x.count), lengthM: pos(x.lengthM) })),
      boxCount: a.boxCount ?? d.boxCount,
      boxMakeupM: a.boxMakeupM ?? d.boxMakeupM,
      panelMakeupM: a.panelMakeupM ?? d.panelMakeupM,
      wastePct: a.wastePct ?? d.wastePct,
    },
    conductors: (run.conductors || []).map((c) => ({ id: c.id || newId(), description: c.description ?? '', size: c.size ?? '', material: c.material === 'al' ? 'al' : 'cu', type: c.type ?? '', count: c.count ?? 1, itemId: c.itemId || null })),
    photos: run.photos || [],
    notes: run.notes ?? '',
  };
}

/** A copy with fresh ids, ready for store.add. */
export function duplicateRun(run, suffix = ' (copy)') {
  const r = normalizeRun(run);
  const { id, createdAt, updatedAt, ...rest } = r;
  void id; void createdAt; void updatedAt;
  return {
    ...structuredClone(rest),
    name: `${r.name || 'Run'}${suffix}`,
    segments: r.segments.map((s) => ({ ...structuredClone(s), id: newId() })),
    conductors: r.conductors.map((c) => ({ ...c, id: newId() })),
    photos: r.photos.map((p) => ({ ...p, id: newId() })),
  };
}

/** 'NMD90 14/2', 'T90 Nylon 12 AWG', 'TECK90 6/3 Al': the description, or one built from the parts. */
export function conductorLabel(c) {
  if (c.description) return c.description;
  return autoDescription(c) || 'Conductor';
}

export function autoDescription(c) {
  const s = String(c.size || '').trim();
  const cable = s.includes('/') && !/^\d\/0$/.test(s);
  const size = s ? (cable || /kcmil|mcm|awg/i.test(s) ? s : Number(s) >= 100 ? `${s} kcmil` : `${s} AWG`) : '';
  return [c.type, size, c.material === 'al' ? 'Al' : ''].filter(Boolean).join(' ');
}

export function conduitLabel(run) {
  if (run.wiringMethod !== 'conduit' || !run.conduit) return '';
  const t = CONDUIT_TYPES.find((x) => x.id === run.conduit.type);
  const s = TRADE_SIZES.find((x) => x.id === String(run.conduit.tradeSize));
  return [t ? t.id : run.conduit.type, s ? s.label : run.conduit.tradeSize].filter(Boolean).join(' ');
}

export function methodLabel(run) {
  return run.wiringMethod === 'conduit' ? `Conduit, ${conduitLabel(run)}` : 'Cable';
}

// ---------- totals ----------
/**
 * Conductor gauge from a size string: '14/2' -> 14, '12' -> 12, '1/0' -> 0, '250' -> kcmil.
 * Returns { awg, kcmil } (one of them null).
 */
export function gaugeOf(size) {
  const s = String(size ?? '').trim().toLowerCase();
  const zero = s.match(/^(\d)\/0/);
  if (zero) return { awg: 1 - Number(zero[1]), kcmil: null }; // 1/0 -> 0, 2/0 -> -1 ...
  const m = s.match(/^(\d+)/);
  if (!m) return { awg: null, kcmil: null };
  const n = Number(m[1]);
  if (n >= 100 || /kcmil|mcm/.test(s)) return { awg: null, kcmil: n };
  return { awg: n, kcmil: null };
}

/** 8 AWG and bigger is usually cut from a reel to length rather than bought in coils. */
export function isCutToLength(size) {
  const g = gaugeOf(size);
  if (g.kcmil) return true;
  return g.awg != null && g.awg < 10;
}

/**
 * Fewest rolls that cover `lengthM` with the least left over.
 * -> { rolls: [{ sizeM, count }], suppliedM, leftoverM, count, single }
 * `single` is the smallest one roll that covers it on its own (or null).
 */
export function suggestRolls(lengthM, sizes = ROLL_SIZES_M) {
  const L = pos(lengthM);
  const sorted = [...sizes].filter((s) => s > 0).sort((a, b) => b - a);
  const single = [...sorted].reverse().find((s) => s >= L - 1e-9) ?? null;
  if (!L || !sorted.length) return { rolls: [], suppliedM: 0, leftoverM: 0, count: 0, single };
  // work in whole centimetres, in steps of the sizes' greatest common divisor
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const cm = sorted.map((s) => Math.round(s * 100));
  const g = cm.reduce(gcd);
  const coins = cm.map((c) => c / g);
  const need = Math.ceil((L * 100) / g - 1e-9);
  const max = need + Math.max(...coins);
  const best = new Array(max + 1).fill(Infinity);
  const pick = new Array(max + 1).fill(-1);
  best[0] = 0;
  for (let t = 1; t <= max; t++) {
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c <= t && best[t - c] + 1 < best[t]) { best[t] = best[t - c] + 1; pick[t] = i; }
    }
  }
  let t = need;
  while (t <= max && best[t] === Infinity) t++;
  const counts = new Array(coins.length).fill(0);
  for (let x = t; x > 0; x -= coins[pick[x]]) counts[pick[x]]++;
  const rolls = sorted.map((sizeM, i) => ({ sizeM, count: counts[i] })).filter((r) => r.count);
  const suppliedM = sum(rolls.map((r) => r.sizeM * r.count));
  return { rolls, suppliedM, leftoverM: r3(suppliedM - L), count: sum(rolls.map((r) => r.count)), single };
}

/**
 * All the numbers for one run.
 * runM = sum of segments; allowances = drops + boxes x makeup + panel makeup;
 * totalM = (runM + allowances) x (1 + waste%) is the length of ONE conductor (or one cable).
 * Each conductor line needs count x totalM. Box and panel makeup only count once the
 * run has some length (segments or drops), so a new, empty run totals zero.
 */
export function runTotals(run) {
  const r = normalizeRun(run);
  const a = r.allowances;
  const runM = sum(r.segments.map((s) => s.lengthM));
  const bySource = { ar: 0, plan: 0, manual: 0 };
  for (const s of r.segments) bySource[s.source] += s.lengthM;
  const drops = a.drops.map((d) => ({ ...d, totalM: r3(d.count * d.lengthM) }));
  const dropsM = sum(drops.map((d) => d.count * d.lengthM));
  const hasPath = runM + dropsM > 0;
  const boxesM = hasPath ? pos(a.boxCount) * pos(a.boxMakeupM) : 0;
  const panelM = hasPath ? pos(a.panelMakeupM) : 0;
  const allowancesM = dropsM + boxesM + panelM;
  const subtotalM = runM + allowancesM;
  const wastePct = pos(a.wastePct);
  const wasteM = (subtotalM * wastePct) / 100;
  const totalM = subtotalM + wasteM;
  const conductors = r.conductors.map((c) => {
    const count = pos(c.count);
    const lengthM = r3(count * totalM);
    const cut = isCutToLength(c.size);
    return { ...c, label: conductorLabel(c), count, lengthM, cut, rolls: cut ? null : suggestRolls(lengthM) };
  });
  const conduitM = r.wiringMethod === 'conduit' ? (runM + dropsM) * (1 + wastePct / 100) : 0;
  return {
    segmentCount: r.segments.length,
    runM: r3(runM), bySource: { ar: r3(bySource.ar), plan: r3(bySource.plan), manual: r3(bySource.manual) },
    drops, dropsM: r3(dropsM), dropCount: sum(a.drops.map((d) => d.count)),
    boxCount: pos(a.boxCount), boxMakeupM: pos(a.boxMakeupM), boxesM: r3(boxesM), panelM: r3(panelM),
    allowancesM: r3(allowancesM), subtotalM: r3(subtotalM), wastePct, wasteM: r3(wasteM), totalM: r3(totalM),
    conductors, conductorM: r3(sum(conductors.map((c) => c.lengthM))),
    conduitM: r3(conduitM), conduitSticks: conduitM ? Math.ceil(conduitM / STICK_M - 1e-9) : 0,
  };
}

// ---------- display ----------
/** Segment lengths to 1/8", totals to the whole inch (metric: cm either way). */
export const fmtSeg = (m, units) => fmtLength(m, { units, denom: 8 });
export const fmtTotal = (m, units) => fmtLength(m, { units, denom: 1 });
/** "48.26 m (158' 4")": the user's units first, the other system after. */
export function fmtBoth(m, units) {
  const other = units === 'imperial' ? 'metric' : 'imperial';
  return `${fmtTotal(m, units)} (${fmtTotal(m, other)})`;
}

export function rollsLabel(r, units = 'metric') {
  if (!r) return 'Cut to length';
  if (!r.rolls.length) return '—';
  const parts = r.rolls.map((x) => `${x.count} × ${x.sizeM} m${units === 'imperial' ? ` (${Math.round(x.sizeM / M_PER_FT)} ft)` : ''}`);
  return parts.join(' + ');
}

export function leftoverLabel(r, units = 'metric') {
  if (!r || !r.rolls.length) return '';
  return `${fmtTotal(r.leftoverM, units)} left over`;
}

export function filterRuns(runs, { q = '', jobId = '', jobs = [] } = {}) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const needle = q.trim().toLowerCase();
  return runs.filter((r) => {
    if (jobId === '__none' ? r.jobId : jobId && r.jobId !== jobId) return false;
    if (!needle) return true;
    const j = byId.get(r.jobId);
    return [r.name, r.location, r.notes, j?.number, j?.title, ...(r.conductors || []).map((c) => c.description)]
      .some((s) => String(s || '').toLowerCase().includes(needle));
  });
}

// ---------- measured paths (AR tape and plan trace) ----------
export function legLengths(points) {
  const out = [];
  for (let i = 1; i < (points || []).length; i++) {
    const a = points[i - 1], b = points[i];
    out.push(Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0), (b.z || 0) - (a.z || 0)));
  }
  return out;
}

/** Drawing pixels to metres with the drawing's scale (px per foot). */
export function pxToM(px, pxPerFt) {
  return pxPerFt > 0 ? (px / pxPerFt) * M_PER_FT : NaN;
}

/**
 * A measured path { totalM, segments: [{ lengthM }], points } -> run segments.
 * One segment for the whole path, or one per leg when `split` is true.
 */
export function segmentsFromPath(path, { source = 'ar', label = '', note = '', split = false } = {}) {
  const legs = (path.segments || []).map((s) => pos(s.lengthM));
  const pts = path.points || [];
  const total = pos(path.totalM) || sum(legs);
  const base = label || (source === 'ar' ? 'AR path' : source === 'plan' ? 'Plan trace' : 'Segment');
  if (split && legs.length > 1) {
    const withPts = pts.length === legs.length + 1;
    return legs.map((lengthM, i) => newSegment({
      label: `${base} ${i + 1}`, lengthM: r3(lengthM), source, note,
      ...(withPts ? { points: [pts[i], pts[i + 1]] } : {}),
    }));
  }
  return [newSegment({ label: base, lengthM: r3(total), source, note, ...(pts.length ? { points: pts } : {}) })];
}

// ---------- price book and estimates ----------
/** Normalise a price-book unit: 'm' | 'ft' | '100ft' | '1000ft' | '100m' | '1000m' | 'roll' | 'stick' | other. */
export function normUnit(unit) {
  const u = String(unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (['m', 'metre', 'meter', 'metres', 'meters', 'lm', 'lin m'].includes(u)) return 'm';
  if (['ft', 'feet', 'foot', 'lf', 'lin ft', "'"].includes(u)) return 'ft';
  if (/^(c|cft|c ft|100 ?ft|per 100 ?ft|100')$/.test(u)) return '100ft';
  if (/^(mft|m ft|kft|1,?000 ?ft|1,?000')$/.test(u)) return '1000ft';
  if (/^100 ?m$/.test(u)) return '100m';
  if (/^(km|1,?000 ?m)$/.test(u)) return '1000m';
  if (/^(roll|coil|spool|reel|box)\b/.test(u) && !/\d/.test(u)) return 'roll';
  if (/^(stick|length|lgth|pc|pcs|piece)s?$/.test(u)) return 'stick';
  return u;
}

/** First length written in a name or unit: '150 m (492\')' -> 150, '10 ft stick' -> 3.048. Metres, or null. */
export function parseItemLength(text) {
  const s = String(text ?? '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)(?![a-z0-9])/i);
  if (m) return Number(m[1]);
  const f = s.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')(?![a-z0-9])/i);
  if (f) return Number(f[1]) * M_PER_FT;
  return null;
}

/**
 * How many of a price-book item cover `lengthM`: { qty, eachM? } in the item's own unit,
 * or null when the unit isn't a length (e.g. 'ea').
 */
export function qtyForItem(lengthM, item) {
  const L = pos(lengthM);
  const u = normUnit(item?.unit);
  switch (u) {
    case 'm': return { qty: ceilTo(L) };
    case 'ft': return { qty: ceilTo(L / M_PER_FT) };
    case '100ft': return { qty: ceilTo(L / M_PER_FT / 100, 2) };
    case '1000ft': return { qty: ceilTo(L / M_PER_FT / 1000, 3) };
    case '100m': return { qty: ceilTo(L / 100, 2) };
    case '1000m': return { qty: ceilTo(L / 1000, 3) };
    case 'roll': {
      const each = parseItemLength(item.name);
      return each ? { qty: ceilTo(L / each), eachM: each } : null;
    }
    case 'stick': {
      const each = parseItemLength(item.unit) || parseItemLength(item.name) || STICK_M;
      return { qty: ceilTo(L / each), eachM: each };
    }
    default: {
      const each = parseItemLength(item?.unit); // e.g. unit '75 m roll'
      return each ? { qty: ceilTo(L / each), eachM: each } : null;
    }
  }
}

/** Price-book items a conductor can be priced from (length-based units, not conduit sticks). */
export function wireItems(items) {
  return items.filter((it) => normUnit(it.unit) !== 'stick' && !/conduit/i.test(it.category || '') && qtyForItem(1, it));
}
export function conduitItems(items) {
  return items.filter((it) => normUnit(it.unit) === 'stick' || (/conduit/i.test(it.category || '') && qtyForItem(1, it)));
}

/** Best guess at the price-book conduit for this run (type and trade size in the name), or null. */
export function matchConduitItem(run, items) {
  if (run.wiringMethod !== 'conduit' || !run.conduit) return null;
  const size = TRADE_SIZES.find((t) => t.id === String(run.conduit.tradeSize));
  let best = null, bestScore = 0;
  for (const it of conduitItems(items)) {
    const name = ` ${String(it.name || '').toLowerCase()} `;
    let score = 0;
    if (name.includes(String(run.conduit.type).toLowerCase())) score += 2;
    if (size && (name.includes(` ${size.inch}"`) || name.includes(` ${size.inch} in`) || name.includes(` ${size.id} mm`) || name.includes(`(${size.id})`))) score += 2;
    if (score > bestScore) { best = it; bestScore = score; }
  }
  return bestScore >= 4 ? best : null;
}

/**
 * Estimate lines for a run, in the shape estimates.js uses:
 * { itemId, description, qty, unitCents, labourHours, kind: 'material' }.
 * Conductors with an itemId are priced from the price book in the item's unit;
 * anything else becomes a custom material line at $0 for the office to price.
 * -> { lines, warnings }
 */
export function estimateLines(run, items, { units = 'metric', includeConduit = true, conduitItemId = null } = {}) {
  const r = normalizeRun(run);
  const t = runTotals(r);
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const lines = [], warnings = [];
  const tag = r.name ? ` (${r.name})` : '';
  const custom = (label, lengthM) => {
    const ft = units === 'imperial';
    lines.push({ itemId: null, description: `${label}, ${ft ? 'ft' : 'm'}${tag}`, qty: ceilTo(ft ? lengthM / M_PER_FT : lengthM), unitCents: 0, labourHours: 0, kind: 'material' });
  };
  for (const c of t.conductors) {
    if (!(c.lengthM > 0)) continue;
    const it = c.itemId ? byId.get(c.itemId) : null;
    const q = it ? qtyForItem(c.lengthM, it) : null;
    if (it && q) {
      lines.push({ itemId: it.id, description: `${it.name}${tag}`, qty: q.qty, unitCents: Number(it.priceCents) || 0, labourHours: Number(it.labourHours) || 0, kind: 'material' });
    } else {
      if (c.itemId && !it) warnings.push(`${c.label}: its price-book item no longer exists, added as a custom line.`);
      else if (it) warnings.push(`${it.name} is priced per "${it.unit}", which isn't a length. ${c.label} was added as a custom line.`);
      custom(c.label, c.lengthM);
    }
  }
  if (includeConduit && r.wiringMethod === 'conduit' && t.conduitM > 0) {
    const it = conduitItemId ? byId.get(conduitItemId) : null;
    const q = it ? qtyForItem(t.conduitM, it) : null;
    if (it && q) lines.push({ itemId: it.id, description: `${it.name}${tag}`, qty: q.qty, unitCents: Number(it.priceCents) || 0, labourHours: Number(it.labourHours) || 0, kind: 'material' });
    else lines.push({ itemId: null, description: `${conduitLabel(r)} conduit, ${STICK_M} m (10 ft) sticks${tag}`, qty: t.conduitSticks, unitCents: 0, labourHours: 0, kind: 'material' });
  }
  if (!lines.length) warnings.push('Nothing to add: the run has no length or no conductors.');
  return { lines, warnings };
}

/** A new draft estimate, the same fields estimates.js `createNew` writes. */
export function newEstimateRecord({ number, settings = {}, job = null, run = null, validUntil = '' }) {
  return {
    number,
    clientId: job?.clientId || null,
    jobId: job?.id || null,
    title: job?.title || (run?.name ? `Wire: ${run.name}` : ''),
    status: 'draft',
    lines: [],
    labourRateCents: settings.labourRateCents ?? 9500,
    markupPct: 0,
    taxPct: settings.taxPct ?? 0,
    notes: '',
    validUntil,
  };
}

// ---------- files ----------
export function sanitizeFileName(s, fallback = 'Wire run') {
  const clean = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return clean || fallback;
}

/** 'Kitchen feed - J-1004.pdf' */
export function runFileName(run, job, ext = 'pdf') {
  const base = sanitizeFileName(run?.name);
  return `${job?.number ? `${base} - ${sanitizeFileName(job.number, '')}`.trim() : base}.${ext}`;
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');
const m3 = (m) => (Math.round(m * 1000) / 1000).toFixed(3);

/** CSV with every number in metres plus the display length in the user's units. */
export function runToCsv(run, { units = 'metric', jobLabel = '' } = {}) {
  const r = normalizeRun(run);
  const t = runTotals(r);
  const rows = [
    ['Wire run', r.name], ['Job', jobLabel], ['Location', r.location], ['Wiring method', methodLabel(r)], ['Units', units], [],
    ['Segments'], ['#', 'Segment', 'Source', 'Length (m)', 'Length', 'Note'],
    ...r.segments.map((s, i) => [i + 1, s.label, SOURCES[s.source], m3(s.lengthM), fmtSeg(s.lengthM, units), s.note]),
    ['', 'Run length', '', m3(t.runM), fmtTotal(t.runM, units), ''], [],
    ['Allowances'], ['Allowance', 'Count', 'Each (m)', 'Length (m)', 'Length'],
    ...t.drops.map((d) => [`Drop: ${d.label || 'drop'}`, d.count, m3(d.lengthM), m3(d.totalM), fmtTotal(d.totalM, units)]),
    ['Box makeup', t.boxCount, m3(t.boxMakeupM), m3(t.boxesM), fmtTotal(t.boxesM, units)],
    ['Panel makeup', 1, m3(t.panelM), m3(t.panelM), fmtTotal(t.panelM, units)],
    [`Waste ${t.wastePct}%`, '', '', m3(t.wasteM), fmtTotal(t.wasteM, units)],
    ['Total per conductor', '', '', m3(t.totalM), fmtTotal(t.totalM, units)], [],
    ['Conductors'], ['Conductor', 'Size', 'Material', 'Type', 'Count', 'Total (m)', 'Total', 'Rolls'],
    ...t.conductors.map((c) => [c.label, c.size, c.material === 'al' ? 'Al' : 'Cu', c.type, c.count, m3(c.lengthM), fmtTotal(c.lengthM, units), rollsLabel(c.rolls, units)]),
  ];
  if (r.wiringMethod === 'conduit') rows.push([], ['Conduit', conduitLabel(r), '', '', '', m3(t.conduitM), fmtTotal(t.conduitM, units), `${t.conduitSticks} sticks of ${STICK_M} m`]);
  if (r.notes) rows.push([], ['Notes', r.notes]);
  return rows.map(csvRow).join('\r\n') + '\r\n';
}

// ---------- PDF report ----------
/**
 * The run as a PDF report (Uint8Array).
 * opts: { company: { name, phone, email, address, licenceNo }, job, client, dateLabel, units, brand }
 */
export function buildRunPdf(run, { company = {}, job = null, client = null, dateLabel = '', units = 'metric', brand = 'Fishtape', drawingName = '' } = {}) {
  const r = normalizeRun(run);
  const t = runTotals(r);
  const { INK, MUTED, FILL, ACCENT } = PDF_COLORS;
  const doc = createPdf({ title: `${r.name || 'Wire run'}${job?.number ? ` - ${job.number}` : ''}`, author: company.name || '', subject: 'Wire run', creator: brand });
  const flow = createFlow(doc, { margin: 40, footer: (i, n) => [`${company.name || brand} · ${r.name || 'Wire run'}`, `Page ${i} of ${n}`] });
  const { left, right, width } = flow;

  // letterhead
  let y = 40;
  doc.text(company.name || 'Company', left, y + 16, { size: 16, bold: true });
  const contact = [company.address, company.phone, company.email].filter(Boolean).join(' · ');
  if (contact) doc.text(contact, left, y + 30, { size: 8.5, color: MUTED });
  if (company.licenceNo) doc.text(`Licence ${company.licenceNo}`, left, y + 41, { size: 8.5, color: MUTED });
  doc.text('WIRE RUN', right, y + 10, { size: 8, bold: true, color: MUTED, align: 'right' });
  if (dateLabel) doc.text(dateLabel, right, y + 24, { size: 10, align: 'right' });
  y += 52;
  doc.rect(left, y, width, 2.5, { fill: ACCENT });
  flow.y = y + 14;

  flow.paragraph(r.name || 'Untitled run', { size: 18, bold: true, gap: 2 });
  const jobLine = job ? [job.number, job.title].filter(Boolean).join(' · ') : '';
  flow.fields([
    ['Job', jobLine || 'Not linked to a job'],
    ['Client', client?.name || ''],
    ['Site', job?.address || ''],
    ['Location', r.location],
    ['Wiring method', methodLabel(r)],
    ['Measured', [t.bySource.ar ? `AR tape ${fmtTotal(t.bySource.ar, units)}` : '', t.bySource.plan ? `plan ${fmtTotal(t.bySource.plan, units)}` : '', t.bySource.manual ? `typed ${fmtTotal(t.bySource.manual, units)}` : ''].filter(Boolean).join(', ') || 'No segments yet'],
    drawingName ? ['Drawing', drawingName] : null,
  ], { columns: 3 });

  // key numbers
  flow.space(4);
  flow.ensure(54);
  const boxes = [['Run length', t.runM], ['Allowances', t.allowancesM], [`Waste ${t.wastePct}%`, t.wasteM], ['Per conductor', t.totalM]];
  const bw = (width - 8 * 3) / 4;
  boxes.forEach(([label, m], i) => {
    const x = left + i * (bw + 8);
    doc.rect(x, flow.y, bw, 46, { fill: i === 3 ? '#fdf0c8' : FILL });
    doc.text(label.toUpperCase(), x + 8, flow.y + 13, { size: 7.5, bold: true, color: MUTED });
    doc.text(fmtTotal(m, units), x + 8, flow.y + 30, { size: 13, bold: true, color: INK });
    doc.text(fmtTotal(m, units === 'imperial' ? 'metric' : 'imperial'), x + 8, flow.y + 41, { size: 7.5, color: MUTED });
  });
  flow.y += 46 + 14;

  flow.heading('Segments', { size: 12 });
  if (r.segments.length) {
    flow.table({
      columns: [{ label: '#', width: 0.4 }, { label: 'Segment', width: 3 }, { label: 'Source', width: 1 }, { label: 'Length', width: 1.4, align: 'right' }, { label: 'Note', width: 3.2 }],
      rows: r.segments.map((s, i) => [i + 1, s.label || '—', SOURCES[s.source], fmtSeg(s.lengthM, units), s.note]),
      total: ['', 'Run length', '', fmtTotal(t.runM, units), ''],
    });
  } else flow.paragraph('No segments measured yet.', { color: MUTED });

  flow.heading('Allowances', { size: 12 });
  flow.table({
    columns: [{ label: 'Allowance', width: 3.4 }, { label: 'Qty', width: 0.8, align: 'right' }, { label: 'Each', width: 1.4, align: 'right' }, { label: 'Length', width: 1.4, align: 'right' }],
    rows: [
      ...t.drops.map((d) => [`Drop: ${d.label || 'drop'}`, d.count, fmtSeg(d.lengthM, units), fmtTotal(d.totalM, units)]),
      [`Box makeup (${CEC_FREE_CONDUCTOR_REF}: ${Math.round(CEC_FREE_CONDUCTOR_M * 1000)} mm free conductor per cable end)`, t.boxCount, fmtSeg(t.boxMakeupM, units), fmtTotal(t.boxesM, units)],
      ['Panel makeup', t.panelM ? 1 : 0, fmtSeg(t.panelM, units), fmtTotal(t.panelM, units)],
      [`Waste (${t.wastePct}% of run and allowances)`, '', '', fmtTotal(t.wasteM, units)],
    ],
    total: ['Total per conductor', '', '', fmtTotal(t.totalM, units)],
  });

  flow.heading('Conductors', { size: 12 });
  if (t.conductors.length) {
    flow.table({
      columns: [{ label: 'Conductor', width: 2.6 }, { label: 'Material', width: 0.9 }, { label: 'Count', width: 0.7, align: 'right' }, { label: 'Total', width: 1.4, align: 'right' }, { label: 'Suggested rolls', width: 2.6 }],
      rows: t.conductors.map((c) => [c.label, c.material === 'al' ? 'Al' : 'Cu', c.count, fmtTotal(c.lengthM, units), c.rolls ? [rollsLabel(c.rolls, units), leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length']),
    });
  } else flow.paragraph('No conductors listed.', { color: MUTED });
  if (r.wiringMethod === 'conduit') {
    flow.paragraph(`Conduit ${conduitLabel(r)}: ${fmtTotal(t.conduitM, units)} including waste, about ${t.conduitSticks} sticks of ${STICK_M} m (10 ft).`, { size: 9.5 });
  }

  if (r.notes) { flow.heading('Notes', { size: 12 }); flow.paragraph(r.notes); }

  const cautions = [];
  if (t.bySource.ar) cautions.push(`AR tape lengths are estimates (typically within about ${AR_TYPICAL_ERROR_PCT}% in good light on textured surfaces). Check critical lengths with a tape before cutting.`);
  if (t.bySource.plan) cautions.push('Plan-traced lengths are only as good as the drawing scale.');
  cautions.push(`Box makeup default follows ${CEC_FREE_CONDUCTOR_REF} (${Math.round(CEC_FREE_CONDUCTOR_M * 1000)} mm free conductor). Check local amendments.`);
  flow.space(2);
  for (const c of cautions) flow.paragraph(c, { size: 8, color: MUTED, gap: 1 });

  const photos = (r.photos || []).filter((p) => typeof p?.dataUrl === 'string' && p.dataUrl.startsWith('data:image/jpeg'));
  if (photos.length) {
    flow.space(6);
    flow.heading('Photos', { size: 12 });
    flow.images(photos.map((p) => ({ src: p.dataUrl, caption: p.caption || '' })), { perRow: 2, maxH: 230 });
  }
  flow.finish();
  return doc.toBytes();
}
