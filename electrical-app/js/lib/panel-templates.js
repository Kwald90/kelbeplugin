// Breaker and whole-panel templates for the panel schedule (S26). Offline-first and
// code-neutral: built-in libraries plus company-saved templates kept in company
// settings (settings.panelTemplates), which already sync. No server collection.
//
import { slotPhase } from './cec/systems.js';
//
// A breaker template fills one circuit in a tap: { id, label, poles, amps, loadVA,
// breakerType, descriptionDefault, group }. loadVA is a typical estimate for balancing,
// nullable where it depends on the actual load (spares, feeders). A panel template is a
// whole-panel preset: { id, label, voltage, mainType, mainAmps, busAmps, slots,
// feedThrough, region }. voltage is a PANEL_SYSTEMS key (js/lib/cec/systems.js).

/** Breaker construction types, with labels for the picker. Stored on a circuit as `breakerType`.
 * 'tandem' and 'quad' are form-factors, not construction types: 'tandem' is a single half-space
 * breaker (1-pole, half A or B); 'quad' is the inner handle-tied 2-pole of a space-saver quad. Both
 * are set by the Tandem/Quad actions and the grid's fixed labels, not chosen from the type dropdown
 * (CONSTRUCTION_TYPE_KEYS is the list the dropdown offers). */
export const BREAKER_TYPES = {
  standard: 'Standard',
  gfci: 'GFCI',
  afci: 'AFCI',
  dual: 'Dual-function (AFCI/GFCI)',
  hacr: 'HACR',
  tandem: 'Tandem (half-space)',
  quad: 'Quad 2-pole (space-saver)',
  'lock-on': 'Lock-on',
};

export const BREAKER_TYPE_KEYS = Object.keys(BREAKER_TYPES);
/** The keys the breaker-type dropdown offers: construction types plus the tandem half-space form.
 * 'quad' is excluded — a quad's inner 2-pole is created by the Quad action, never picked here. */
export const CONSTRUCTION_TYPE_KEYS = BREAKER_TYPE_KEYS.filter((k) => k !== 'quad');
export const breakerTypeLabel = (t) => BREAKER_TYPES[t] || BREAKER_TYPES.standard;

// Company-managed circuit-name suggestions for the panel description type-ahead (a native
// <datalist>). Shipped as a sensible default list when the company has not set its own; editable in
// Settings (settings.panelCircuitNames). Offline, CSP-safe — just strings bound to each input.
export const DEFAULT_CIRCUIT_NAMES = [
  'Kitchen plugs', 'Bedroom plugs', 'Bathroom plugs (GFCI)', 'Living room plugs', 'Dining room',
  'Counter plugs', 'Fridge', 'Dishwasher', 'Microwave', 'Range', 'Dryer', 'Washer', 'Furnace',
  'A/C condenser', 'Heat pump', 'Water heater', 'HRV/ERV', 'Sump pump', 'Garage plugs', 'Garage door',
  'Outside plugs', 'Exterior lights', 'Lighting', 'Pot lights', 'Smoke/CO alarms', 'Sub panel',
  'EV charger', 'Hot tub', 'Pool', 'Well pump', 'Septic alarm', 'Air compressor', 'Shop plugs',
  'Spare', 'Space',
];

/**
 * The circuit-name suggestions to show in the description type-ahead: the company's
 * settings.panelCircuitNames when it has any, otherwise DEFAULT_CIRCUIT_NAMES. Trimmed and
 * de-duplicated (case-insensitively, first spelling kept). Pure.
 */
export function panelCircuitNames(settings) {
  const raw = settings && Array.isArray(settings.panelCircuitNames) ? settings.panelCircuitNames : null;
  const src = raw && raw.length ? raw : DEFAULT_CIRCUIT_NAMES;
  const seen = new Set();
  const out = [];
  for (const n of src) {
    const name = String(n ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Built-in breaker library. Canadian residential and light-commercial defaults. loadVA values
// are typical estimates (nameplate/trade rules of thumb), good enough for phase balancing; they
// are not a demand calculation. Grouped for the picker.
export const BUILT_IN_BREAKERS = [
  // Receptacles
  { id: 'recept-15', label: '15 A general receptacles', poles: 1, amps: 15, loadVA: 1440, breakerType: 'standard', descriptionDefault: 'Receptacles', group: 'Receptacles' },
  { id: 'recept-20', label: '20 A general receptacles', poles: 1, amps: 20, loadVA: 1920, breakerType: 'standard', descriptionDefault: 'Receptacles', group: 'Receptacles' },
  { id: 'recept-15-gfci', label: '15 A kitchen / bath receptacles (GFCI)', poles: 1, amps: 15, loadVA: 1440, breakerType: 'gfci', descriptionDefault: 'Kitchen / bath receptacles', group: 'Receptacles' },
  { id: 'recept-20-gfci', label: '20 A kitchen / bath receptacles (GFCI)', poles: 1, amps: 20, loadVA: 1500, breakerType: 'gfci', descriptionDefault: 'Counter receptacles', group: 'Receptacles' },
  // Lighting
  { id: 'light-15-afci', label: '15 A lighting (AFCI)', poles: 1, amps: 15, loadVA: 1200, breakerType: 'afci', descriptionDefault: 'Lighting', group: 'Lighting' },
  { id: 'light-20', label: '20 A lighting', poles: 1, amps: 20, loadVA: 1600, breakerType: 'standard', descriptionDefault: 'Lighting', group: 'Lighting' },
  // Appliances
  { id: 'laundry-20', label: '20 A laundry', poles: 1, amps: 20, loadVA: 1500, breakerType: 'standard', descriptionDefault: 'Laundry', group: 'Appliances' },
  { id: 'dryer-30', label: '30 A dryer (2-pole)', poles: 2, amps: 30, loadVA: 5000, breakerType: 'standard', descriptionDefault: 'Dryer', group: 'Appliances' },
  { id: 'range-40', label: '40 A range (2-pole)', poles: 2, amps: 40, loadVA: 8000, breakerType: 'standard', descriptionDefault: 'Range', group: 'Appliances' },
  { id: 'wh-30', label: '30 A water heater (2-pole)', poles: 2, amps: 30, loadVA: 4500, breakerType: 'standard', descriptionDefault: 'Water heater', group: 'Appliances' },
  // HVAC
  { id: 'ac-30', label: '30 A A/C or heat (2-pole, HACR)', poles: 2, amps: 30, loadVA: 5000, breakerType: 'hacr', descriptionDefault: 'Air conditioner', group: 'HVAC' },
  { id: 'ac-40', label: '40 A A/C or heat (2-pole, HACR)', poles: 2, amps: 40, loadVA: 7680, breakerType: 'hacr', descriptionDefault: 'Heat pump', group: 'HVAC' },
  { id: 'ac-50', label: '50 A A/C or heat (2-pole, HACR)', poles: 2, amps: 50, loadVA: 9600, breakerType: 'hacr', descriptionDefault: 'A/C or heat', group: 'HVAC' },
  // EV and special loads
  { id: 'ev-50', label: '50 A EV charger (2-pole)', poles: 2, amps: 50, loadVA: 9600, breakerType: 'standard', descriptionDefault: 'EV charger', group: 'EV & special' },
  { id: 'hottub-60-gfci', label: '60 A hot tub (2-pole, GFCI)', poles: 2, amps: 60, loadVA: 11520, breakerType: 'gfci', descriptionDefault: 'Hot tub', group: 'EV & special' },
  // Feeders
  { id: 'subfeed-100', label: '100 A sub-feed (2-pole)', poles: 2, amps: 100, loadVA: null, breakerType: 'standard', descriptionDefault: 'Sub-panel feed', group: 'Feeders', subFeed: true },
  { id: 'subfeed-60', label: '60 A sub-feed (2-pole)', poles: 2, amps: 60, loadVA: null, breakerType: 'standard', descriptionDefault: 'Sub-panel feed', group: 'Feeders', subFeed: true },
  // Tandem / space-saver (half-height: two single-pole breakers share one full space, A over B)
  { id: 'tandem-15', label: '15 A tandem (half-space)', poles: 1, amps: 15, loadVA: 1440, breakerType: 'tandem', descriptionDefault: 'Receptacles', group: 'Tandem / space-saver' },
  { id: 'tandem-20', label: '20 A tandem (half-space)', poles: 1, amps: 20, loadVA: 1920, breakerType: 'tandem', descriptionDefault: 'Receptacles', group: 'Tandem / space-saver' },
  { id: 'tandem-15-light', label: '15 A tandem lighting (half-space)', poles: 1, amps: 15, loadVA: 1200, breakerType: 'tandem', descriptionDefault: 'Lighting', group: 'Tandem / space-saver' },
  // Quad / space-saver inner 2-pole (Eaton/Square D/Siemens "quad"): one device = two outer singles
  // plus this inner handle-tied 2-pole across two spaces. The template places only the inner 2-pole
  // (in the inner halves Nb + N+1a); the two outer halves stay open for single-pole breakers.
  { id: 'quad-30', label: '30 A quad inner 2-pole (space-saver)', poles: 2, amps: 30, loadVA: 0, breakerType: 'standard', quad: true, descriptionDefault: '240 V load', group: 'Tandem / space-saver' },
  { id: 'quad-20', label: '20 A quad inner 2-pole (space-saver)', poles: 2, amps: 20, loadVA: 0, breakerType: 'standard', quad: true, descriptionDefault: '240 V load', group: 'Tandem / space-saver' },
  // Other
  { id: 'spare', label: 'Spare', poles: 1, amps: 20, loadVA: 0, breakerType: 'standard', descriptionDefault: 'Spare', group: 'Other' },
  { id: 'space', label: 'Space (blank)', poles: 1, amps: null, loadVA: 0, breakerType: 'standard', descriptionDefault: 'Space', group: 'Other' },
];

// Built-in whole-panel presets. mainType: 'MLO' (main-lug-only, no main breaker — mainAmps is the
// feed/OCPD rating upstream) or 'MB' (main breaker). region: 'CA' | 'US' | 'CA US'.
export const BUILT_IN_PANELS = [
  { id: 'res-100', label: 'Residential 100 A · 120/240 V · 24 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 100, busAmps: 100, slots: 24, feedThrough: false, region: 'CA US' },
  { id: 'res-125', label: 'Residential 125 A · 120/240 V · 32 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 125, busAmps: 125, slots: 32, feedThrough: false, region: 'CA US' },
  { id: 'res-200', label: 'Residential 200 A · 120/240 V · 40 spaces', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 40, feedThrough: false, region: 'CA US' },
  { id: 'comm-225-208', label: 'Commercial 225 A · 120/208 V 3φ · 42 spaces (MLO)', voltage: '208/120 3ph', mainType: 'MLO', mainAmps: 225, busAmps: 225, slots: 42, feedThrough: false, region: 'CA US' },
  { id: 'comm-400-208', label: 'Distribution 400 A · 120/208 V 3φ · 30 spaces (MB)', voltage: '208/120 3ph', mainType: 'MB', mainAmps: 400, busAmps: 400, slots: 30, feedThrough: true, region: 'CA US' },
  { id: 'comm-600-600', label: 'Distribution 600 A · 347/600 V 3φ · 42 spaces (MLO)', voltage: '347/600 3ph', mainType: 'MLO', mainAmps: 600, busAmps: 600, slots: 42, feedThrough: true, region: 'CA' },
  { id: 'comm-400-480', label: 'Commercial 400 A · 277/480 V 3φ · 42 spaces (MLO)', voltage: '480/277 3ph', mainType: 'MLO', mainAmps: 400, busAmps: 400, slots: 42, feedThrough: false, region: 'US' },
];

// The circuits a typical Canadian house ends up with — the reference an estimator leans on so none
// get missed when quoting, and the starting layout for a residential panel schedule. Each entry
// points at a BUILT_IN_BREAKERS id for its poles/amps/loadVA/type, with a `count` (repeat it),
// a `tier` and an optional `breakerType` override and `note`. tier: 'required' (code expects it on
// essentially every dwelling), 'recommended' (standard good practice), 'optional' (include when the
// house has it). These are estimating/reference aids, not a code ruling — verify against the CEC and
// the local authority. Rule citations are to CSA C22.1:24.
export const RESIDENTIAL_ESSENTIALS = [
  { id: 'counter', breaker: 'recept-20-gfci', label: 'Kitchen counter plugs', count: 2, tier: 'required', note: 'At least two 20 A small-appliance counter circuits; receptacles within 1.5 m of a sink are GFCI (CEC 26-712, 26-700).' },
  { id: 'fridge', breaker: 'recept-15', label: 'Refrigerator', count: 1, tier: 'recommended', note: 'A dedicated circuit so a tripped kitchen plug never thaws the fridge.' },
  { id: 'dishwasher', breaker: 'recept-15', label: 'Dishwasher', count: 1, tier: 'recommended' },
  { id: 'microwave', breaker: 'recept-20', label: 'Microwave', count: 1, tier: 'recommended' },
  { id: 'bath', breaker: 'recept-15-gfci', label: 'Bathroom plugs (GFCI)', count: 1, tier: 'required', note: 'Bathroom receptacles are GFCI-protected (CEC 26-700).' },
  { id: 'laundry', breaker: 'laundry-20', label: 'Laundry', count: 1, tier: 'required' },
  { id: 'dryer', breaker: 'dryer-30', label: 'Dryer', count: 1, tier: 'recommended' },
  { id: 'range', breaker: 'range-40', label: 'Range', count: 1, tier: 'recommended' },
  { id: 'water-heater', breaker: 'wh-30', label: 'Water heater', count: 1, tier: 'recommended' },
  { id: 'furnace', breaker: 'recept-15', label: 'Furnace / air handler', count: 1, tier: 'required', note: 'Dedicated circuit for the heating appliance.' },
  { id: 'general', breaker: 'recept-15', label: 'General receptacles', count: 3, tier: 'required', breakerType: 'afci', note: 'AFCI protection for the 125 V receptacle circuits in a dwelling (CEC 26-724).' },
  { id: 'lighting', breaker: 'light-15-afci', label: 'Lighting', count: 2, tier: 'required' },
  { id: 'smoke', breaker: 'light-15-afci', label: 'Smoke / CO alarms', count: 1, tier: 'required', note: 'Interconnected, on an unswitched lighting circuit.' },
  { id: 'outdoor', breaker: 'recept-15-gfci', label: 'Outdoor plugs (GFCI)', count: 1, tier: 'required', note: 'Outdoor receptacles are GFCI-protected (CEC 26-700).' },
  { id: 'garage', breaker: 'recept-20-gfci', label: 'Garage plugs (GFCI)', count: 1, tier: 'recommended' },
  { id: 'hrv', breaker: 'recept-15', label: 'HRV / ERV', count: 1, tier: 'recommended' },
  { id: 'sump', breaker: 'recept-15', label: 'Sump pump', count: 1, tier: 'optional', note: 'Dedicated; keep it off the GFCI/AFCI you reset often.' },
  { id: 'ac', breaker: 'ac-30', label: 'A/C or heat pump', count: 1, tier: 'optional' },
  { id: 'ev', breaker: 'ev-50', label: 'EV charger', count: 1, tier: 'optional', note: 'New builds often rough-in a 50 A circuit for a future EVSE.' },
];

const BREAKER_BY_ID = Object.fromEntries(BUILT_IN_BREAKERS.map((b) => [b.id, b]));

/** The essentials as reference rows for the checklist UI: each with its poles/amps/type resolved from
 * the referenced breaker, plus tier/note/count. `defaultOn` is true for required + recommended. Pure. */
export function residentialEssentials() {
  return RESIDENTIAL_ESSENTIALS.map((e) => {
    const b = BREAKER_BY_ID[e.breaker] || {};
    return { id: e.id, label: e.label, count: e.count || 1, tier: e.tier, note: e.note || null,
      poles: Number(b.poles) || 1, amps: b.amps ?? 20, loadVA: b.loadVA ?? 0,
      breakerType: e.breakerType || b.breakerType || 'standard', defaultOn: e.tier !== 'optional' };
  });
}

/** Expand the chosen essentials (ids; null = required + recommended) into individual circuit specs
 * { poles, amps, loadVA, breakerType, description }, numbering repeats ("Lighting 1", "Lighting 2"). Pure. */
export function expandResidentialEssentials(selectedIds = null) {
  const chosen = RESIDENTIAL_ESSENTIALS.filter((e) => (selectedIds ? selectedIds.includes(e.id) : e.tier !== 'optional'));
  const out = [];
  for (const e of chosen) {
    const b = BREAKER_BY_ID[e.breaker] || {};
    const n = e.count || 1;
    for (let i = 0; i < n; i++) {
      out.push({ poles: Number(b.poles) || 1, amps: b.amps ?? 20, loadVA: b.loadVA ?? 0,
        breakerType: e.breakerType || b.breakerType || 'standard',
        description: n > 1 ? `${e.label} ${i + 1}` : e.label });
    }
  }
  return out;
}

/**
 * Place circuit specs into panel slots balanced for load. 2-pole breakers go in first (they occupy
 * slot s and s+2, which are consecutive rows and so always straddle A and B — inherently balanced);
 * then 1-pole circuits are assigned heaviest-first to whichever phase is currently lighter, matched
 * to the lowest free slot carrying that phase. Returns circuits with a `slot` set, sorted by slot.
 * Honours the panel's slot count (drops what will not fit) and leaves any `occupied` slots alone, so
 * it can fill the empty spaces of a panel that already has breakers. Pure — phase from systems.slotPhase.
 */
export function layoutResidentialCircuits(specs, { system = '120/240 1ph', slots = 40, occupied = [] } = {}) {
  const taken = new Set(occupied.map(Number));
  const free = new Set();
  for (let s = 1; s <= slots; s++) if (!taken.has(s)) free.add(s);
  const phaseAt = (s) => slotPhase(s, system);
  const load = {};
  const addLoad = (p, va) => { load[p] = (load[p] || 0) + va; };
  const placed = [];

  const twos = specs.filter((c) => (Number(c.poles) || 1) >= 2).sort((a, b) => (b.loadVA || 0) - (a.loadVA || 0));
  const ones = specs.filter((c) => (Number(c.poles) || 1) < 2).sort((a, b) => (b.loadVA || 0) - (a.loadVA || 0));

  for (const c of twos) {
    let at = null;
    for (let s = 1; s + 2 <= slots; s++) { if (free.has(s) && free.has(s + 2)) { at = s; break; } }
    if (at == null) continue;
    free.delete(at); free.delete(at + 2);
    addLoad(phaseAt(at), (c.loadVA || 0) / 2);
    addLoad(phaseAt(at + 2), (c.loadVA || 0) / 2);
    placed.push({ ...c, slot: at });
  }

  for (const c of ones) {
    if (!free.size) break;
    const byPhase = {};
    for (const s of [...free].sort((a, b) => a - b)) { (byPhase[phaseAt(s)] ||= []).push(s); }
    const target = Object.keys(byPhase).sort((a, b) => (load[a] || 0) - (load[b] || 0))[0];
    const s = byPhase[target][0];
    free.delete(s);
    addLoad(target, c.loadVA || 0);
    placed.push({ ...c, slot: s });
  }

  return placed.sort((a, b) => a.slot - b.slot);
}

const custom = (settings, kind) => {
  const pt = settings?.panelTemplates;
  return pt && Array.isArray(pt[kind]) ? pt[kind] : [];
};

/** Built-in breaker templates (marked custom:false) merged with the company's saved ones (custom:true). */
export function listBreakerTemplates(settings) {
  const builtin = BUILT_IN_BREAKERS.map((t) => ({ ...t, custom: false }));
  const saved = custom(settings, 'breakers').map((t) => ({ ...t, custom: true }));
  return [...builtin, ...saved];
}

/** Built-in panel presets merged with any company-saved ones. */
export function listPanelTemplates(settings) {
  const builtin = BUILT_IN_PANELS.map((t) => ({ ...t, custom: false }));
  const saved = custom(settings, 'panels').map((t) => ({ ...t, custom: true }));
  return [...builtin, ...saved];
}

/** Fields a breaker template contributes to a circuit. Null amps leaves the current amps alone. */
export function applyBreakerTemplate(tpl, base = {}) {
  const out = { ...base };
  out.description = tpl.descriptionDefault ?? base.description ?? '';
  out.poles = Number(tpl.poles) || base.poles || 1;
  out.amps = tpl.amps == null ? (base.amps ?? 20) : Number(tpl.amps);
  out.loadVA = tpl.loadVA == null ? (base.loadVA ?? 0) : Number(tpl.loadVA);
  out.breakerType = tpl.breakerType || 'standard';
  if (tpl.subFeed) out.subFeed = true;
  return out;
}

/** Save the current breaker as a reusable company template. Returns the template id. */
export function saveBreakerTemplate(store, tpl) {
  const s = store.settings();
  const pt = s.panelTemplates || {};
  const breakers = Array.isArray(pt.breakers) ? pt.breakers : [];
  const id = tpl.id || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const clean = {
    id,
    label: String(tpl.label || tpl.descriptionDefault || 'Custom breaker').slice(0, 200),
    poles: Number(tpl.poles) || 1,
    amps: tpl.amps == null ? null : Number(tpl.amps),
    loadVA: tpl.loadVA == null ? null : Number(tpl.loadVA),
    breakerType: tpl.breakerType || 'standard',
    descriptionDefault: String(tpl.descriptionDefault ?? ''),
    group: tpl.group || 'Company',
  };
  if (tpl.subFeed) clean.subFeed = true;
  const next = [...breakers.filter((t) => t.id !== id), clean];
  store.saveSettings({ panelTemplates: { ...pt, breakers: next } });
  return id;
}

/** Remove a company-saved breaker template by id. Built-ins are not removable. */
export function removeBreakerTemplate(store, id) {
  const s = store.settings();
  const pt = s.panelTemplates || {};
  const breakers = (Array.isArray(pt.breakers) ? pt.breakers : []).filter((t) => t.id !== id);
  store.saveSettings({ panelTemplates: { ...pt, breakers } });
}
